import { getLanguageModelForProfile } from './providers';
import type { RouteTarget } from '@/lib/config/store';
import { createMastraAgent, resolveMastraModelTimeout } from '@/lib/mastra/runtime';
import {
  isAbortError,
  mergeAbortSignals,
  probeMastraStream,
  type MastraTextStreamPart,
} from '@/lib/mastra/streaming';

export interface FallbackStreamResult {
  firstPart: MastraTextStreamPart;
  rest: AsyncIterable<MastraTextStreamPart>;
  profileId: string;
  modelId: string;
  failures: Array<{ profileId: string; modelId: string; error: string }>;
}

interface StreamAttemptParams {
  instructions: string;
  messages: Array<Record<string, unknown>>;
  providerOptions?: unknown;
  modelSettings?: unknown;
  tools?: Record<string, unknown>;
  toolChoice?: unknown;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  memory?: unknown;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'agent';
}

export async function streamWithFallback(
  targets: RouteTarget[],
  buildParams: (profileId: string, modelId: string) => StreamAttemptParams,
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
      const agent = await createMastraAgent({
        id: `compat-${sanitizeId(target.profileId)}-${sanitizeId(target.modelId)}`,
        name: 'Compat Chat Agent',
        instructions: params.instructions || 'You are a helpful AI assistant.',
        model,
        tools: params.tools as never,
      });
      const result = await agent.stream(params.messages as never, {
        ...(params.memory ? { memory: params.memory } : {}),
        ...(params.providerOptions ? { providerOptions: params.providerOptions } : {}),
        ...(params.modelSettings ? { modelSettings: params.modelSettings } : {}),
        ...(params.toolChoice ? { toolChoice: params.toolChoice as never } : {}),
        ...(params.maxSteps ? { maxSteps: params.maxSteps } : {}),
        ...(attemptAbortSignal ? { abortSignal: attemptAbortSignal } : {}),
        timeout: resolveMastraModelTimeout(),
      } as never);

      const { firstPart, rest } = await probeMastraStream(result.fullStream as unknown as ReadableStream<MastraTextStreamPart>, {
        abortSignal: attemptAbortSignal,
      });

      console.info('[stream-with-fallback] attempt succeeded', {
        profileId: target.profileId,
        modelId: target.modelId,
        elapsed: Date.now() - attemptStart,
        failureCount: failures.length,
      });

      return { firstPart, rest, profileId: target.profileId, modelId: target.modelId, failures };
    } catch (error) {
      if (abortSignal?.aborted || isAbortError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ profileId: target.profileId, modelId: target.modelId, error: message });
      console.warn('[stream-with-fallback] attempt failed', {
        profileId: target.profileId,
        modelId: target.modelId,
        elapsed: Date.now() - attemptStart,
        error: message,
      });
    }
  }

  const summary = failures.map((failure) => `${failure.profileId}/${failure.modelId}: ${failure.error}`).join('; ');
  throw new Error(`All route attempts failed. ${summary}`);
}

export function buildAutoTargets(modelPriority: RouteTarget[]): RouteTarget[] {
  const seen = new Set<string>();
  const out: RouteTarget[] = [];
  for (const target of modelPriority) {
    const key = `${target.profileId}/${target.modelId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}
