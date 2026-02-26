import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { getLanguageModelForProfile } from './providers';
import type { RouteTarget } from '@/lib/config/store';

type StreamTextParams = Omit<Parameters<typeof streamText>[0], 'model' | 'maxRetries'>;

export interface FallbackStreamResult {
  parts: TextStreamPart<ToolSet>[];
  profileId: string;
  modelId: string;
  failures: Array<{ profileId: string; modelId: string; error: string }>;
}

/**
 * Try each target in order, collecting fullStream parts.
 * On error (thrown or error part), move to the next target.
 * Returns the first successful result or throws if all targets fail.
 */
export async function streamWithFallback(
  targets: RouteTarget[],
  buildParams: (profileId: string, modelId: string) => StreamTextParams,
  maxAttempts = targets.length,
): Promise<FallbackStreamResult> {
  const failures: Array<{ profileId: string; modelId: string; error: string }> = [];
  const attempts = targets.slice(0, Math.max(1, maxAttempts));

  for (const target of attempts) {
    const attemptStart = Date.now();
    try {
      const { model } = await getLanguageModelForProfile(target.profileId, target.modelId);
      const params = buildParams(target.profileId, target.modelId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = streamText({ ...params, model, maxRetries: 0 } as any);

      const parts: TextStreamPart<ToolSet>[] = [];
      let streamError: string | undefined;

      for await (const part of result.fullStream) {
        if (part.type === 'error') {
          streamError = (part.error as Error)?.message ?? String(part.error);
        } else {
          parts.push(part);
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      console.info('[stream-with-fallback] attempt succeeded', {
        profileId: target.profileId,
        modelId: target.modelId,
        elapsed: Date.now() - attemptStart,
        failureCount: failures.length,
      });

      return { parts, profileId: target.profileId, modelId: target.modelId, failures };
    } catch (err) {
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
 * Build an ordered list of targets for auto-routing:
 * the global modelPriority list, deduplicated.
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
