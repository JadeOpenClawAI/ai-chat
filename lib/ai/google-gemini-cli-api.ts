import { createParser } from 'eventsource-parser';

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

interface CodeAssistWrapper {
  response?: unknown;
}

function toCodeAssistUrl(operation: 'generateContent' | 'streamGenerateContent'): string {
  const suffix = operation === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${operation}${suffix}`;
}

function extractModelAndOperation(url: URL): { model: string; operation: 'generateContent' | 'streamGenerateContent' } | null {
  const match = url.pathname.match(/\/models\/(.+):(generateContent|streamGenerateContent)$/);
  if (!match) {
    return null;
  }

  const rawModel = decodeURIComponent(match[1]).replace(/^models\//, '');
  const operation = match[2] as 'generateContent' | 'streamGenerateContent';
  return { model: rawModel, operation };
}

function createSseUnwrapStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let parser: ReturnType<typeof createParser> | undefined;

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      parser = createParser({
        onEvent(event) {
          if (!event.data) {
            return;
          }

          let payload: unknown = event.data;
          try {
            const parsed = JSON.parse(event.data) as CodeAssistWrapper;
            if (parsed && typeof parsed === 'object' && 'response' in parsed) {
              payload = parsed.response;
            }
          } catch {
            payload = event.data;
          }

          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        },
      });
    },
    transform(chunk) {
      parser?.feed(textDecoder.decode(chunk, { stream: true }));
    },
    flush() {
      parser?.feed(textDecoder.decode());
      parser?.reset({ consume: true });
    },
  }));
}

export function makeGeminiCliCodeAssistFetch(
  projectId: string,
  normalizeModelId: (modelId: string) => string,
): typeof fetch {
  return async (input, init) => {
    const originalUrl = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const extracted = extractModelAndOperation(originalUrl);

    if (!extracted) {
      return fetch(input, init);
    }

    const model = normalizeModelId(extracted.model);
    const requestPayload = (() => {
      if (typeof init?.body !== 'string') {
        return {};
      }
      try {
        return JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    const headers = new Headers(init?.headers);
    headers.delete('x-goog-api-key');
    headers.set('Content-Type', 'application/json');
    headers.set('User-Agent', 'google-api-nodejs-client/9.15.1');
    headers.set('X-Goog-Api-Client', 'gl-node/22.17.0');

    const response = await fetch(toCodeAssistUrl(extracted.operation), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        project: projectId,
        user_prompt_id: crypto.randomUUID(),
        request: requestPayload,
      }),
      signal: init?.signal,
    });

    if (extracted.operation === 'streamGenerateContent') {
      if (!response.ok) {
        return response;
      }
      if (!response.body) {
        return response;
      }
      const streamHeaders = new Headers(response.headers);
      streamHeaders.set('content-type', 'text/event-stream');
      return new Response(createSseUnwrapStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: streamHeaders,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = {
          error: {
            code: response.status,
            message: text || response.statusText || 'Code Assist request failed',
            status: 'UNKNOWN',
          },
        };
      }

      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    let body: unknown;
    try {
      const parsed = JSON.parse(text) as CodeAssistWrapper;
      if (parsed && typeof parsed === 'object' && 'response' in parsed) {
        body = parsed.response;
      } else {
        body = parsed;
      }
    } catch {
      body = text;
    }

    const jsonHeaders = new Headers(response.headers);
    jsonHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: jsonHeaders,
    });
  };
}
