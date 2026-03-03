import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { getLanguageModelForProfile } from './providers';
import type { RouteTarget } from '@/lib/config/store';

export interface FallbackStreamResult {
  /** First content part that confirmed the stream is healthy. */
  firstPart: TextStreamPart<ToolSet>;
  /** Async iterator for the remaining parts (does not include firstPart). */
  rest: AsyncIterable<TextStreamPart<ToolSet>>;
  profileId: string;
  modelId: string;
  failures: Array<{ profileId: string; modelId: string; error: string }>;
}

type StreamTextParams = Omit<Parameters<typeof streamText>[0], 'model' | 'maxRetries'>;

function isAbortError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return err.name === 'AbortError' || message.includes('aborted') || message.includes('abort');
  }
  return false;
}

function mergeAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) {
    return second;
  }
  if (!second || first === second) {
    return first;
  }
  if (first.aborted) {
    return first;
  }
  if (second.aborted) {
    return second;
  }

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  first.addEventListener('abort', () => abortFrom(first), { once: true });
  second.addEventListener('abort', () => abortFrom(second), { once: true });
  return controller.signal;
}

/**
 * Try each target in order.  For each attempt, read parts until we either:
 *   - see a `text-delta`  → commit: return that part + the remaining iterator
 *   - see an `error` part → fail this target, try next
 *   - iterator throws     → fail this target, try next
 *
 * The caller receives the first confirmed text-delta and an async iterator
 * for the rest, so it can start flushing to the client immediately without
 * buffering the full response.
 */
export async function streamWithFallback(
  targets: RouteTarget[],
  buildParams: (profileId: string, modelId: string) => StreamTextParams,
  maxAttempts = targets.length,
  abortSignal?: AbortSignal,
): Promise<FallbackStreamResult> {
  const failures: Array<{ profileId: string; modelId: string; error: string }> = [];
  const attempts = targets.slice(0, Math.max(1, maxAttempts));

  for (const target of attempts) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Request aborted');
    }
    const attemptStart = Date.now();
    try {
      const { model } = await getLanguageModelForProfile(target.profileId, target.modelId);
      const params = buildParams(target.profileId, target.modelId);
      const attemptAbortSignal = mergeAbortSignals(params.abortSignal, abortSignal);
      const result = streamText({
        ...params,
        ...(attemptAbortSignal ? { abortSignal: attemptAbortSignal } : {}),
        model,
        maxRetries: 0,
      } as Parameters<typeof streamText>[0]);

      const iter = result.fullStream[Symbol.asyncIterator]();
      let firstPart: TextStreamPart<ToolSet> | undefined;
      let streamError: string | undefined;

      // Peek: read parts until we find the first text-delta or an error
      while (true) {
        if (abortSignal?.aborted) {
          throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Request aborted');
        }
        let next: IteratorResult<TextStreamPart<ToolSet>>;
        try {
          next = await iter.next();
        } catch (err) {
          streamError = (err as Error).message ?? String(err);
          break;
        }

        if (next.done) {
          // Stream ended without any text-delta — treat as error
          streamError = streamError ?? 'Stream ended without producing any content';
          break;
        }

        const part = next.value;
        if (part.type === 'error') {
          streamError = (part.error as Error)?.message ?? String(part.error);
          break;
        }
        if (part.type === 'text-delta' || part.type === 'tool-input-start' || part.type === 'tool-call') {
          firstPart = part;
          break;
        }
        // Any other part type (lifecycle, metadata, etc.) — keep peeking
      }

      if (streamError || !firstPart) {
        throw new Error(streamError ?? 'No content from provider');
      }

      // Build a combined async iterable: drain any remaining parts from iter
      const rest: AsyncIterable<TextStreamPart<ToolSet>> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return iter.next() as Promise<IteratorResult<TextStreamPart<ToolSet>>>;
            },
            return(value) {
              return iter.return?.(value) ?? Promise.resolve({ done: true as const, value });
            },
          };
        },
      };

      console.info('[stream-with-fallback] attempt succeeded', {
        profileId: target.profileId,
        modelId: target.modelId,
        elapsed: Date.now() - attemptStart,
        failureCount: failures.length,
      });

      return { firstPart, rest, profileId: target.profileId, modelId: target.modelId, failures };
    } catch (err) {
      if (abortSignal?.aborted || isAbortError(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ profileId: target.profileId, modelId: target.modelId, error: msg });
      console.warn('[stream-with-fallback] attempt failed', {
        profileId: target.profileId,
        modelId: target.modelId,
        elapsed: Date.now() - attemptStart,
        error: msg,
      });
    }
  }

  const summary = failures.map((f) => `${f.profileId}/${f.modelId}: ${f.error}`).join('; ');
  throw new Error(`All route attempts failed. ${summary}`);
}

/**
 * Build an ordered list of targets for auto-routing from the global modelPriority,
 * deduplicated.
 */
export function buildAutoTargets(modelPriority: RouteTarget[]): RouteTarget[] {
  const seen = new Set<string>();
  const out: RouteTarget[] = [];
  for (const t of modelPriority) {
    const key = `${t.profileId}/${t.modelId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
