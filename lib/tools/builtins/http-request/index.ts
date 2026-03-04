import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { URL } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DiagnosticsLevelSchema = z.enum(['basic', 'full']);
const ParamsValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
]);
const AuthSchema = z.union([
  z.string(),
  z.object({
    username: z.union([z.string(), z.number(), z.boolean()]),
    password: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);

const HttpRequestSchema = z.object({
  url: z.string().describe('The URL to request'),
  method: HttpMethodSchema.optional().describe('HTTP method (default: GET)'),
  headers: z.record(z.string()).optional().describe('Custom request headers as key-value pairs'),
  'kyletest-options': z.object({
    needme: z.string().describe('A test option to verify custom properties are passed correctly'),
    optionalOne: z.number().optional().describe('An optional test property to verify flexibility in handling additional properties'),
  }).catchall(z.string()).optional().describe('Compatibility field preserved from runtime tool schema'),
  body: z.unknown().optional().describe('Request body (string/object/Buffer). Objects are sent as JSON.'),
  params: z.record(ParamsValueSchema).optional().describe('URL query parameters as key-value pairs'),
  timeout: z.number().optional().describe('Request timeout in ms (default: 30000)'),
  followRedirects: z.boolean().optional().describe('Whether to follow redirects (default: true)'),
  maxRedirects: z.number().optional().describe('Max redirects to follow (default: 5)'),
  maxBodyChars: z.number().optional().describe('Max response body chars returned (default: 50000)'),
  auth: AuthSchema.optional().describe('Basic auth credentials'),
  rejectUnauthorized: z.boolean().optional().describe('TLS cert verification (default: true)'),
  diagnosticsLevel: DiagnosticsLevelSchema.optional().describe('Diagnostics detail level (default: basic)'),
});

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

type ParamsValue = z.infer<typeof ParamsValueSchema>;
type AuthValue = z.infer<typeof AuthSchema>;
type DiagnosticsLevel = z.infer<typeof DiagnosticsLevelSchema>;

interface Timings {
  startAt: number;
  socketAssignedAt: number | null;
  lookupAt: number | null;
  connectAt: number | null;
  secureConnectAt: number | null;
  uploadFinishedAt: number | null;
  firstByteAt: number | null;
  endAt: number | null;
}

interface HopResult {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  bodyBuffer: Buffer;
  bytes: number;
  timings: Timings;
}

type ExtendedTLSSocket = TLSSocket & {
  getPeerX509Certificate?: () => {
    subject?: unknown;
    issuer?: unknown;
    validFrom?: unknown;
    validTo?: unknown;
    serialNumber?: unknown;
    fingerprint256?: unknown;
    subjectAltName?: unknown;
  } | null;
  getEphemeralKeyInfo?: () => unknown;
  getSharedSigalgs?: () => unknown;
  isSessionReused?: () => unknown;
};

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function isTlsSocket(socket: Socket | null): socket is TLSSocket {
  return Boolean(socket && 'encrypted' in socket);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonLike {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      length: value.length,
      base64: value.toString('base64'),
    };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const out: { [key: string]: JsonLike } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(entry, seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (/authorization|proxy-authorization|cookie|set-cookie/i.test(key)) {
      out[key] = '[REDACTED]';
    }
  }
  return out;
}

function appendParams(url: string, params: Record<string, ParamsValue> | undefined): string {
  if (!params) {
    return url;
  }

  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        next.searchParams.append(key, String(item));
      }
    } else {
      next.searchParams.set(key, String(value));
    }
  }
  return next.toString();
}

function parseAuth(auth: AuthValue | undefined): string | null {
  if (!auth) {
    return null;
  }
  if (typeof auth === 'string') {
    return auth;
  }
  return `${String(auth.username)}:${String(auth.password)}`;
}

function toBodyBuffer(body: unknown, requestHeaders: Record<string, string>): {
  data: Buffer | null;
  headers: Record<string, string>;
} {
  if (body === undefined || body === null) {
    return { data: null, headers: requestHeaders };
  }

  const headers = { ...requestHeaders };

  if (Buffer.isBuffer(body)) {
    if (!headers['content-length']) {
      headers['content-length'] = String(body.length);
    }
    return { data: body, headers };
  }

  if (typeof body === 'string') {
    const buffer = Buffer.from(body);
    if (!headers['content-type']) {
      headers['content-type'] = 'text/plain; charset=utf-8';
    }
    if (!headers['content-length']) {
      headers['content-length'] = String(buffer.length);
    }
    return { data: buffer, headers };
  }

  if (isRecord(body)) {
    const serialized = JSON.stringify(body);
    const buffer = Buffer.from(serialized);
    if (!headers['content-type']) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    if (!headers['content-length']) {
      headers['content-length'] = String(buffer.length);
    }
    return { data: buffer, headers };
  }

  const serialized = String(body);
  const buffer = Buffer.from(serialized);
  if (!headers['content-length']) {
    headers['content-length'] = String(buffer.length);
  }
  return { data: buffer, headers };
}

function doRequest(args: {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  timeout: number;
  auth: AuthValue | undefined;
  rejectUnauthorized: boolean;
}): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(args.targetUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestHeaders = normalizeHeaders(args.headers);
    const authValue = parseAuth(args.auth);
    if (authValue && !requestHeaders.authorization) {
      requestHeaders.authorization = `Basic ${Buffer.from(authValue).toString('base64')}`;
    }

    const { data: requestBodyBuffer, headers: finalHeaders } = toBodyBuffer(args.body, requestHeaders);

    const timings: Timings = {
      startAt: Date.now(),
      socketAssignedAt: null,
      lookupAt: null,
      connectAt: null,
      secureConnectAt: null,
      uploadFinishedAt: null,
      firstByteAt: null,
      endAt: null,
    };

    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: args.method,
      headers: finalHeaders,
      timeout: args.timeout,
      rejectUnauthorized: args.rejectUnauthorized,
      servername: url.hostname,
    };

    const req = transport.request(options, (res) => {
      if (!timings.firstByteAt) {
        timings.firstByteAt = Date.now();
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.on('end', () => {
        timings.endAt = Date.now();
        resolve({
          req,
          res,
          bodyBuffer: Buffer.concat(chunks),
          bytes,
          timings,
        });
      });
    });

    req.on('socket', (socket) => {
      timings.socketAssignedAt = Date.now();
      socket.once('lookup', () => {
        timings.lookupAt = Date.now();
      });
      socket.once('connect', () => {
        timings.connectAt = Date.now();
      });
      socket.once('secureConnect', () => {
        timings.secureConnectAt = Date.now();
      });
    });

    req.setTimeout(args.timeout, () => req.destroy(new Error(`Request timeout after ${args.timeout}ms`)));
    req.on('error', reject);

    if (requestBodyBuffer && requestBodyBuffer.length > 0) {
      req.write(requestBodyBuffer);
    }
    timings.uploadFinishedAt = Date.now();
    req.end();
  });
}

function statusText(code: number): string {
  return http.STATUS_CODES[code] ?? '';
}

export const httpRequestTool = tool({
  description: 'Makes an HTTP request using built-in Node http/https modules and returns response details '
    + 'with optional deep TLS/X.509 diagnostics.',
  inputSchema: HttpRequestSchema,
  execute: async ({
    url,
    method = 'GET',
    headers = {},
    body,
    params,
    timeout = 30000,
    followRedirects = true,
    maxRedirects = 5,
    maxBodyChars = 50000,
    auth,
    rejectUnauthorized = true,
    diagnosticsLevel = 'basic',
  }) => {
    const full = diagnosticsLevel === 'full';
    const startedAt = Date.now();

    try {
      const initialUrl = appendParams(url, params);
      const redirects: Array<{ hop: number; statusCode: number; from: string; to: string }> = [];
      let currentUrl = initialUrl;
      let hop = 0;
      let finalHop: HopResult | null = null;

      while (true) {
        const hopResult = await doRequest({
          targetUrl: currentUrl,
          method: String(method || 'GET').toUpperCase(),
          headers,
          body,
          timeout,
          auth,
          rejectUnauthorized,
        });

        const statusCode = hopResult.res.statusCode ?? 0;
        const location = hopResult.res.headers.location;
        const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

        if (followRedirects && isRedirect && typeof location === 'string') {
          if (hop >= maxRedirects) {
            finalHop = hopResult;
            break;
          }

          const nextUrl = new URL(location, currentUrl).toString();
          redirects.push({
            hop: hop + 1,
            statusCode,
            from: currentUrl,
            to: nextUrl,
          });
          currentUrl = nextUrl;
          hop += 1;
          continue;
        }

        finalHop = hopResult;
        break;
      }

      if (!finalHop) {
        throw new Error('Request finished without a final response hop');
      }

      const { req, res, bodyBuffer, bytes, timings } = finalHop;
      const socketCandidate = (req.socket ?? res.socket ?? null) as Socket | null;
      const tlsSocket = isTlsSocket(socketCandidate) ? socketCandidate : null;
      const isTls = Boolean(tlsSocket);

      const textBody = bodyBuffer.toString('utf8');
      const truncated = textBody.length > maxBodyChars;
      const bodyText = truncated ? textBody.slice(0, maxBodyChars) : textBody;

      let parsedJson: unknown = null;
      try {
        parsedJson = JSON.parse(textBody);
      } catch {
        parsedJson = null;
      }

      const timing = {
        totalMs: timings.endAt && timings.startAt ? timings.endAt - timings.startAt : null,
        dnsLookupMs: timings.lookupAt && timings.socketAssignedAt ? timings.lookupAt - timings.socketAssignedAt : null,
        tcpConnectMs: (() => {
          const connectStart = timings.lookupAt ?? timings.socketAssignedAt;
          return timings.connectAt && connectStart
            ? timings.connectAt - connectStart
            : null;
        })(),
        tlsHandshakeMs: timings.secureConnectAt && timings.connectAt ? timings.secureConnectAt - timings.connectAt : null,
        ttfbMs: timings.firstByteAt && timings.uploadFinishedAt ? timings.firstByteAt - timings.uploadFinishedAt : null,
        downloadMs: timings.endAt && timings.firstByteAt ? timings.endAt - timings.firstByteAt : null,
        startAt: timings.startAt,
        endAt: timings.endAt,
      };

      const tlsBase: Record<string, unknown> = {
        enabled: isTls,
        authorization: isTls
          ? {
            authorized: tlsSocket?.authorized ?? false,
            authorizationError: tlsSocket?.authorizationError ?? null,
          }
          : null,
        protocol: isTls ? safe(() => tlsSocket?.getProtocol()) : null,
        cipher: isTls ? safe(() => tlsSocket?.getCipher()) : null,
        alpnProtocol: isTls ? (tlsSocket?.alpnProtocol ?? null) : null,
        servername: isTls ? (tlsSocket?.servername ?? null) : null,
      };

      if (full && tlsSocket) {
        const extendedSocket = tlsSocket as ExtendedTLSSocket;
        const peerX509 = safe(() => extendedSocket.getPeerX509Certificate?.());
        const peerLegacy = safe(() => tlsSocket.getPeerCertificate(true));
        const peerLegacyRecord: Record<string, unknown> = isRecord(peerLegacy) ? peerLegacy : {};

        tlsBase.deep = {
          ephemeralKeyInfo: safe(() => extendedSocket.getEphemeralKeyInfo?.()),
          sharedSignatureAlgorithms: safe(() => extendedSocket.getSharedSigalgs?.()),
          sessionReused: safe(() => extendedSocket.isSessionReused?.()),
          peerCertificate: {
            subject: safe(() => peerX509?.subject) ?? peerLegacyRecord.subject ?? null,
            issuer: safe(() => peerX509?.issuer) ?? peerLegacyRecord.issuer ?? null,
            validFrom: safe(() => peerX509?.validFrom) ?? peerLegacyRecord['valid_from'] ?? null,
            validTo: safe(() => peerX509?.validTo) ?? peerLegacyRecord['valid_to'] ?? null,
            serialNumber: safe(() => peerX509?.serialNumber) ?? peerLegacyRecord.serialNumber ?? null,
            fingerprint256: safe(() => peerX509?.fingerprint256) ?? peerLegacyRecord.fingerprint256 ?? null,
            subjectAltName: safe(() => peerX509?.subjectAltName) ?? peerLegacyRecord['subjectaltname'] ?? null,
          },
        };
      }

      const result = {
        request: {
          method: String(method).toUpperCase(),
          url: initialUrl,
          finalUrl: currentUrl,
          headers: redactHeaders(normalizeHeaders(headers)),
        },
        status: {
          code: res.statusCode ?? 0,
          text: statusText(res.statusCode ?? 0),
          isSuccess: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        },
        url: {
          requested: initialUrl,
          final: currentUrl,
          wasRedirected: redirects.length > 0,
          redirectCount: redirects.length,
          redirectChain: redirects,
        },
        response: {
          httpVersion: res.httpVersion,
          headers: res.headers,
        },
        body: {
          text: bodyText,
          byteLength: bytes,
          charLength: textBody.length,
          truncated,
          maxCharsApplied: maxBodyChars,
          contentType: res.headers['content-type'] || null,
          contentLengthHeader: res.headers['content-length'] || null,
          contentEncoding: res.headers['content-encoding'] || null,
          isJson: parsedJson !== null,
          json: parsedJson,
          sha256: crypto.createHash('sha256').update(bodyBuffer).digest('hex'),
        },
        connection: {
          remoteAddress: socketCandidate?.remoteAddress || null,
          remotePort: socketCandidate?.remotePort || null,
          localAddress: socketCandidate?.localAddress || null,
          localPort: socketCandidate?.localPort || null,
        },
        tls: tlsBase,
        timing,
        timingTotal: { elapsedMs: Date.now() - startedAt },
        diagnosticsLevel: (full ? 'full' : 'basic') as DiagnosticsLevel,
      };

      return jsonSafe(result);
    } catch (error) {
      return {
        error: true,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error && isRecord(error) && typeof error.code === 'string' ? error.code : null,
        name: error instanceof Error ? error.name : null,
        stack: error instanceof Error ? error.stack ?? null : null,
        elapsedMs: Date.now() - startedAt,
        request: {
          method: String(method).toUpperCase(),
          url,
        },
      };
    }
  },
});

export const httpRequestToolMetadata: BuiltinToolMetadata = {
  icon: '📡',
  description: 'HTTP/HTTPS request tool with redirects, body parsing, and optional TLS diagnostics.',
  expectedDurationMs: 1500,
  inputs: [
    'url',
    'method?',
    'headers?',
    'body?',
    'params?',
    'timeout?',
    'followRedirects?',
    'maxRedirects?',
    'maxBodyChars?',
    'auth?',
    'rejectUnauthorized?',
    'diagnosticsLevel?',
  ],
  outputs: ['request', 'status', 'response', 'body', 'connection', 'tls', 'timing', 'error?'],
};
