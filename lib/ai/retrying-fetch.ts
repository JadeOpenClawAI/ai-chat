const DEFAULT_RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  409, // Conflict
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  524, // Cloudflare timeout
]);

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export interface RetryingFetchOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

export const DEFAULT_RETRYING_FETCH_OPTIONS: Required<RetryingFetchOptions> = {
  maxRetries: 2,
  initialDelayMs: 200,
  backoffFactor: 2,
  maxDelayMs: 1_200,
  jitterRatio: 0.2,
};

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('abort');
  }
  return false;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const directCode = (error as Error & { code?: string }).code;
  const causeCode = (error as Error & { cause?: { code?: string } }).cause?.code;
  if ((directCode && RETRYABLE_ERROR_CODES.has(directCode)) || (causeCode && RETRYABLE_ERROR_CODES.has(causeCode))) {
    return true;
  }

  const message = error.message.toLowerCase();
  if (message.includes('econnreset') || message.includes('eai_again') || message.includes('eaiagain')) {
    return true;
  }

  // `fetch failed` is the generic undici network failure wrapper.
  if (message.includes('fetch failed') || message.includes('socket hang up') || message.includes('connection reset')) {
    return true;
  }

  return false;
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) {
    return undefined;
  }

  const asSeconds = Number.parseFloat(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDateMs = Date.parse(retryAfterHeader);
  if (Number.isNaN(asDateMs)) {
    return undefined;
  }

  return Math.max(0, asDateMs - Date.now());
}

function addJitter(delayMs: number, jitterRatio: number): number {
  if (delayMs <= 0 || jitterRatio <= 0) {
    return delayMs;
  }
  const variance = delayMs * jitterRatio;
  const min = delayMs - variance;
  const max = delayMs + variance;
  return Math.max(0, Math.round(min + Math.random() * (max - min)));
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  const abortSignal = signal;
  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(abortSignal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createRetryingFetch(
  baseFetch: typeof fetch = fetch,
  options?: RetryingFetchOptions,
): typeof fetch {
  const {
    maxRetries,
    initialDelayMs,
    backoffFactor,
    maxDelayMs,
    jitterRatio,
  } = { ...DEFAULT_RETRYING_FETCH_OPTIONS, ...(options ?? {}) };

  return async (input, init) => {
    const abortSignal = init?.signal ?? undefined;
    let retriesUsed = 0;
    let nextDelayMs = initialDelayMs;

    while (true) {
      try {
        const response = await baseFetch(input, init);
        const shouldRetry =
          retriesUsed < maxRetries && (
            DEFAULT_RETRYABLE_STATUS_CODES.has(response.status) || response.status >= 500
          );

        if (!shouldRetry) {
          return response;
        }

        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs = retryAfterMs !== undefined
          ? Math.min(maxDelayMs, Math.max(0, retryAfterMs))
          : Math.min(maxDelayMs, addJitter(nextDelayMs, jitterRatio));

        // Ensure failed response bodies are not left hanging before retrying.
        if (response.body) {
          try {
            await response.body.cancel();
          } catch {
            // Ignore response body cancellation failures.
          }
        }
        await sleep(delayMs, abortSignal);

        retriesUsed += 1;
        nextDelayMs = Math.min(maxDelayMs, Math.round(nextDelayMs * backoffFactor));
      } catch (error) {
        if (isAbortError(error) || retriesUsed >= maxRetries || !isRetryableNetworkError(error)) {
          throw error;
        }

        const delayMs = Math.min(maxDelayMs, addJitter(nextDelayMs, jitterRatio));
        await sleep(delayMs, abortSignal);

        retriesUsed += 1;
        nextDelayMs = Math.min(maxDelayMs, Math.round(nextDelayMs * backoffFactor));
      }
    }
  };
}
