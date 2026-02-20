#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const process = require('process');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const next = require('next');

const DEFAULT_PORT = 1455;
const DEFAULT_HOST = '0.0.0.0';
const GENERATED_CERT_DIR = path.join(os.homedir(), '.ai-chat', 'dev-certs');
const TLS_START_BYTES = new Set([20, 21, 22, 23, 128]);
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const DEBUG_MUX = isTruthy(process.env.DEV_MUX_DEBUG);

const OPENSSL_CONFIG = [
  '[req]',
  'distinguished_name = dn',
  'x509_extensions = v3_req',
  'prompt = no',
  '',
  '[dn]',
  'CN = localhost',
  '',
  '[v3_req]',
  'subjectAltName = @alt_names',
  '',
  '[alt_names]',
  'DNS.1 = localhost',
  'IP.1 = 127.0.0.1',
  'IP.2 = ::1',
  '',
].join('\n');

function isTruthy(value) {
  if (value === undefined || value === null) {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readArgValue(argv, index, name) {
  const nextValue = argv[index + 1];
  if (!nextValue || nextValue.startsWith('-')) {
    throw new Error(`${name} requires a value.`);
  }
  return nextValue;
}

function parseCliArgs(argv) {
  let port;
  let host;
  let dir = '.';
  let dirAssigned = false;
  let forceHttps = false;
  let turbo = false;
  let showHelp = false;
  let keyFile;
  let certFile;
  let caFile;
  const unknownArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-p' || arg === '--port') {
      port = parsePort(readArgValue(argv, i, arg), port);
      i += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length), port);
      continue;
    }

    if (arg === '-H' || arg === '--hostname') {
      host = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith('--hostname=')) {
      host = arg.slice('--hostname='.length);
      continue;
    }

    if (arg === '--experimental-https') {
      forceHttps = true;
      continue;
    }

    if (arg === '--experimental-https-key') {
      keyFile = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith('--experimental-https-key=')) {
      keyFile = arg.slice('--experimental-https-key='.length);
      continue;
    }

    if (arg === '--experimental-https-cert') {
      certFile = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith('--experimental-https-cert=')) {
      certFile = arg.slice('--experimental-https-cert='.length);
      continue;
    }

    if (arg === '--experimental-https-ca') {
      caFile = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith('--experimental-https-ca=')) {
      caFile = arg.slice('--experimental-https-ca='.length);
      continue;
    }

    if (arg === '--turbo' || arg === '--turbopack') {
      turbo = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    if (arg.startsWith('-')) {
      unknownArgs.push(arg);
      continue;
    }

    if (!dirAssigned) {
      dir = arg;
      dirAssigned = true;
    } else {
      unknownArgs.push(arg);
    }
  }

  return {
    port,
    host,
    dir,
    forceHttps,
    turbo,
    keyFile,
    certFile,
    caFile,
    showHelp,
    unknownArgs,
  };
}

function getDisplayHost(host) {
  if (host === '0.0.0.0' || host === '::') {
    return 'localhost';
  }
  return host;
}

function formatOrigin(protocol, host, port) {
  return `${protocol}://${getDisplayHost(host)}:${port}`;
}

function createRedirectServer({ publicHost, publicPort }) {
  const fallbackHost = `${getDisplayHost(publicHost)}:${publicPort}`;
  const server = http.createServer((req, res) => {
    const host = req.headers.host || fallbackHost;
    const location = `https://${host}${req.url || '/'}`;
    res.statusCode = 307;
    res.setHeader('Location', location);
    res.setHeader('Content-Length', '0');
    res.end();
  });

  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return server;
}

function startMuxServer({ publicHost, publicPort, tlsServer, plainServer }) {
  return new Promise((resolve, reject) => {
    const muxServer = net.createServer((socket) => {
      const onReadable = () => {
        const firstByteBuffer = socket.read(1);
        if (!firstByteBuffer) {
          return;
        }

        socket.removeListener('readable', onReadable);
        const firstByte = firstByteBuffer[0];
        const targetServer = TLS_START_BYTES.has(firstByte) ? tlsServer : plainServer;
        if (DEBUG_MUX) {
          const route = targetServer === tlsServer ? 'https' : 'http';
          console.log(`[dev-server] mux route=${route} firstByte=0x${firstByte.toString(16)}`);
        }

        socket.unshift(firstByteBuffer);
        socket.server = targetServer;
        targetServer.emit('connection', socket);
      };

      socket.on('error', () => socket.destroy());
      socket.on('readable', onReadable);
      onReadable();
    });

    muxServer.on('error', reject);
    muxServer.listen(publicPort, publicHost, () => resolve(muxServer));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

function ensureGeneratedLocalhostCert() {
  const certDir = path.resolve(process.env.DEV_GENERATED_CERT_DIR || GENERATED_CERT_DIR);
  const keyPath = path.join(certDir, 'localhost-key.pem');
  const certPath = path.join(certDir, 'localhost-cert.pem');
  const confPath = path.join(certDir, 'openssl.cnf');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const certPem = fs.readFileSync(certPath);
      const cert = new crypto.X509Certificate(certPem);
      const expiresAt = new Date(cert.validTo).getTime();
      const notExpired = Number.isFinite(expiresAt) && expiresAt > Date.now() + ONE_DAY_MS;
      const san = cert.subjectAltName || '';
      const hasLocalhostSan = san.includes('DNS:localhost');
      if (notExpired && hasLocalhostSan) {
        return { keyPath, certPath, generated: false, reused: true };
      }
    } catch {
      // Fall through to regenerate.
    }
  }

  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(confPath, OPENSSL_CONFIG, { mode: 0o600 });

  const opensslArgs = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '30',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    confPath,
    '-extensions',
    'v3_req',
  ];

  const result = spawnSync('openssl', opensslArgs, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `Failed to run openssl (${result.error.message}). Provide certs via DEV_HTTPS_KEY_FILE/DEV_HTTPS_CERT_FILE or set NO_SELF_SIGNED_CERT=1.`,
    );
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`openssl failed generating localhost cert (${details || `exit code ${result.status}`}).`);
  }

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);

  return { keyPath, certPath, generated: true, reused: false };
}

function resolveHttpsConfig(parsedArgs) {
  const explicitKeyPath = parsedArgs.keyFile || process.env.DEV_HTTPS_KEY_FILE;
  const explicitCertPath = parsedArgs.certFile || process.env.DEV_HTTPS_CERT_FILE;
  const explicitCaPath = parsedArgs.caFile || process.env.DEV_HTTPS_CA_FILE;

  const hasExplicitCerts = Boolean(explicitKeyPath || explicitCertPath || explicitCaPath);
  const noSelfSignedCert = isTruthy(process.env.NO_SELF_SIGNED_CERT);
  const useHttps = parsedArgs.forceHttps || hasExplicitCerts || !noSelfSignedCert;

  if (!useHttps) {
    return { useHttps: false };
  }

  let keyPath = explicitKeyPath;
  let certPath = explicitCertPath;
  let caPath = explicitCaPath;
  let generatedCertInfo = null;

  if (!keyPath && !certPath && !caPath && !noSelfSignedCert) {
    generatedCertInfo = ensureGeneratedLocalhostCert();
    keyPath = generatedCertInfo.keyPath;
    certPath = generatedCertInfo.certPath;
  }

  if (!keyPath || !certPath) {
    throw new Error(
      'HTTPS requires both key and cert. Set DEV_HTTPS_KEY_FILE and DEV_HTTPS_CERT_FILE, or unset NO_SELF_SIGNED_CERT.',
    );
  }

  const key = fs.readFileSync(path.resolve(keyPath));
  const cert = fs.readFileSync(path.resolve(certPath));
  const ca = caPath ? fs.readFileSync(path.resolve(caPath)) : undefined;

  return {
    useHttps: true,
    tlsOptions: ca ? { key, cert, ca } : { key, cert },
    generatedCertInfo,
  };
}

async function main() {
  const parsedArgs = parseCliArgs(process.argv.slice(2));

  if (parsedArgs.showHelp) {
    console.log('Usage: pnpm dev [directory] [--port|-p <port>] [--hostname|-H <host>] [--turbo]');
    console.log('       [--experimental-https] [--experimental-https-key <path>] [--experimental-https-cert <path>] [--experimental-https-ca <path>]');
    return;
  }

  const publicPort = parsedArgs.port ?? parsePort(process.env.PORT, DEFAULT_PORT);
  const publicHost = parsedArgs.host ?? process.env.HOST ?? DEFAULT_HOST;
  const projectDir = path.resolve(parsedArgs.dir);

  if (parsedArgs.unknownArgs.length > 0) {
    console.warn(`[dev-server] Ignoring unsupported args: ${parsedArgs.unknownArgs.join(' ')}`);
  }

  const httpsConfig = resolveHttpsConfig(parsedArgs);
  const redirectEnabled = httpsConfig.useHttps && !isTruthy(process.env.NO_HTTP_TO_HTTPS_REDIRECT);

  const app = next({
    dev: true,
    dir: projectDir,
    hostname: publicHost,
    port: publicPort,
    turbo: parsedArgs.turbo,
    turbopack: parsedArgs.turbo,
  });

  await app.prepare();
  const handleRequest = app.getRequestHandler();
  const handleUpgrade = app.getUpgradeHandler();

  const servers = [];

  if (!httpsConfig.useHttps) {
    const httpServer = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error('[dev-server] Request handler failed:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end('Internal Server Error');
      });
    });
    httpServer.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(publicPort, publicHost, resolve);
    });

    servers.push(httpServer);
    console.log(`[dev-server] HTTP mode on ${formatOrigin('http', publicHost, publicPort)}`);
  } else {
    const httpsServer = https.createServer(httpsConfig.tlsOptions, (req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error('[dev-server] Request handler failed:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end('Internal Server Error');
      });
    });
    httpsServer.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });

    const plainServer = redirectEnabled
      ? createRedirectServer({ publicHost, publicPort })
      : http.createServer((req, res) => {
          handleRequest(req, res).catch((error) => {
            console.error('[dev-server] Request handler failed:', error);
            if (!res.headersSent) {
              res.statusCode = 500;
            }
            res.end('Internal Server Error');
          });
        });
    if (!redirectEnabled) {
      plainServer.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head).catch(() => socket.destroy());
      });
    }

    const muxServer = await startMuxServer({
      publicHost,
      publicPort,
      tlsServer: httpsServer,
      plainServer,
    });

    servers.push(muxServer, httpsServer, plainServer);
    console.log(`[dev-server] HTTPS enabled on ${formatOrigin('https', publicHost, publicPort)}`);
    if (httpsConfig.generatedCertInfo) {
      const certAction = httpsConfig.generatedCertInfo.generated ? 'Generated' : 'Reusing';
      console.log(
        `[dev-server] ${certAction} localhost cert at ${httpsConfig.generatedCertInfo.certPath} (no sudo required).`,
      );
    }
    if (redirectEnabled) {
      console.log(`[dev-server] Plain HTTP on port ${publicPort} now redirects to HTTPS.`);
    } else {
      console.log('[dev-server] HTTP to HTTPS redirect is disabled.');
    }
  }

  let shuttingDown = false;
  const shutdown = async (exitCode) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    await Promise.allSettled(servers.map((server) => closeServer(server)));
    if (typeof app.close === 'function') {
      await app.close();
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    shutdown(0).catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown(0).catch(() => process.exit(1));
  });
  process.on('SIGHUP', () => {
    shutdown(0).catch(() => process.exit(1));
  });
}

main().catch((error) => {
  console.error('[dev-server] Fatal error:', error);
  process.exit(1);
});
