// ============================================================
// Tool Result Summarizer
// Automatically summarizes large tool results before adding to context
// ============================================================

import { generateText, streamText } from 'ai'
import type { ModelInvocationContext } from './providers'
import { getProviderOptionsForCall } from './providers'
import { estimateTokens } from './context-manager'
import type { ToolCompactionPolicy } from '@/lib/config/store'

// ── Configuration ─────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseIntWithFallback(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const DEFAULT_TOOL_COMPACTION_POLICY: ToolCompactionPolicy = {
  mode: 'summary',
  thresholdTokens: parseIntWithFallback(
    process.env.TOOL_COMPACTION_THRESHOLD ?? process.env.TOOL_RESULT_SUMMARY_THRESHOLD,
    2000,
  ),
  summaryMaxTokens: parseIntWithFallback(process.env.TOOL_COMPACTION_SUMMARY_MAX_TOKENS, 1000),
  summaryInputMaxChars: parseIntWithFallback(process.env.TOOL_COMPACTION_INPUT_MAX_CHARS, 50000),
  truncateMaxChars: parseIntWithFallback(process.env.TOOL_COMPACTION_TRUNCATE_MAX_CHARS, 8000),
}

function normalizeMode(value: unknown): ToolCompactionPolicy['mode'] {
  if (value === 'off' || value === 'summary' || value === 'truncate') return value
  if (value === 'disabled' || value === 'none') return 'off'
  return DEFAULT_TOOL_COMPACTION_POLICY.mode
}

function getToolCompactionPolicy(overrides?: Partial<ToolCompactionPolicy>): ToolCompactionPolicy {
  return {
    mode: normalizeMode(overrides?.mode),
    thresholdTokens: clamp(
      Math.floor(overrides?.thresholdTokens ?? DEFAULT_TOOL_COMPACTION_POLICY.thresholdTokens),
      1,
      1_000_000,
    ),
    summaryMaxTokens: clamp(
      Math.floor(overrides?.summaryMaxTokens ?? DEFAULT_TOOL_COMPACTION_POLICY.summaryMaxTokens),
      100,
      4000,
    ),
    summaryInputMaxChars: clamp(
      Math.floor(overrides?.summaryInputMaxChars ?? DEFAULT_TOOL_COMPACTION_POLICY.summaryInputMaxChars),
      1000,
      500000,
    ),
    truncateMaxChars: clamp(
      Math.floor(overrides?.truncateMaxChars ?? DEFAULT_TOOL_COMPACTION_POLICY.truncateMaxChars),
      500,
      200000,
    ),
  }
}

export function shouldSummarizeToolResult(
  toolResult: string,
  modelId: string,
  policyOverrides?: Partial<ToolCompactionPolicy>,
): {
  shouldSummarize: boolean
  tokenCount: number
  threshold: number
  mode: ToolCompactionPolicy['mode']
} {
  const policy = getToolCompactionPolicy(policyOverrides)
  const threshold = policy.thresholdTokens
  const tokenCount = estimateTokens(toolResult, modelId)
  const shouldCompact = policy.mode !== 'off' && tokenCount > threshold
  return {
    shouldSummarize: shouldCompact,
    tokenCount,
    threshold,
    mode: policy.mode,
  }
}

// ── Summarization system prompt ───────────────────────────────

const TOOL_SUMMARY_SYSTEM = `You are a concise information extractor. Given the raw output from a tool call, extract and summarize the most relevant information.

Guidelines:
- Keep important facts, numbers, URLs, code snippets, and decisions
- Remove redundant, repetitive, or low-value content
- Preserve structure where useful (e.g., lists, tables)
- Keep your summary under 500 words unless the content requires more
- Start directly with the summary (no preamble like "This tool returned...")
- Use markdown for structure`

const TOOL_SUMMARY_TASK_PROMPT = `Task instructions:
${TOOL_SUMMARY_SYSTEM}`

// ── Types ────────────────────────────────────────────────────

export interface SummarizeResult {
  text: string
  wasSummarized: boolean
  originalTokens: number
  summaryTokens: number
  tokensFreed: number
}

// ── Main summarizer ───────────────────────────────────────────

/**
 * Summarizes a tool result if it exceeds the token threshold.
 * Returns the result (possibly summarized) and metadata.
 */
export async function maybeSummarizeToolResult(
  toolName: string,
  toolResult: string,
  invocation: ModelInvocationContext,
  userQuery?: string,
  policyOverrides?: Partial<ToolCompactionPolicy>,
  baseSystemPrompt?: string,
): Promise<SummarizeResult> {
  const policy = getToolCompactionPolicy(policyOverrides)
  const threshold = policy.thresholdTokens
  const originalTokens = estimateTokens(toolResult, invocation.modelId)

  if (policy.mode === 'off' || originalTokens <= threshold) {
    return {
      text: toolResult,
      wasSummarized: false,
      originalTokens,
      summaryTokens: originalTokens,
      tokensFreed: 0,
    }
  }

  if (policy.mode === 'truncate') {
    const truncated = toolResult.slice(0, policy.truncateMaxChars)
    const truncTokens = estimateTokens(truncated, invocation.modelId)
    return {
      text: `[Truncated from ${originalTokens} tokens]\n\n${truncated}`,
      wasSummarized: true,
      originalTokens,
      summaryTokens: truncTokens,
      tokensFreed: originalTokens - truncTokens,
    }
  }

  try {
    const contextHint = userQuery
      ? `\n\nUser's current request: "${userQuery}"`
      : ''

    const prompt = `Tool: ${toolName}${contextHint}\n\nRaw output:\n\`\`\`\n${toolResult.slice(0, policy.summaryInputMaxChars)}\n\`\`\``
    console.info('[Summarizer] tool summary started', {
      toolName,
      mode: policy.mode,
      threshold,
      originalTokens,
      hasBaseSystemPrompt: Boolean(baseSystemPrompt?.trim()),
      baseSystemPromptChars: baseSystemPrompt?.length ?? 0,
    })

    const summarySystemPrompt = baseSystemPrompt?.trim() || TOOL_SUMMARY_SYSTEM
    const providerOptions = getProviderOptionsForCall(invocation, summarySystemPrompt)
    
    
    const useMessages = [
      { role: 'system' as const, content: summarySystemPrompt },
      ...(summarySystemPrompt != TOOL_SUMMARY_SYSTEM ? [{ role: 'system' as const, content: TOOL_SUMMARY_SYSTEM }] : []),
      { role: 'user' as const, content: `${TOOL_SUMMARY_TASK_PROMPT}\n\n${prompt}` },
    ];

    const streamTextReturnObj = await streamText({
      model: invocation.model,
      messages: useMessages,
      maxTokens: policy.summaryMaxTokens,
      maxRetries: 0,
      ...(providerOptions ? { providerOptions } : {}),
    });
    await streamTextReturnObj.consumeStream({
      onError: err => {
        console.error('[ContextManager] error during summary generation', err instanceof Error ? err.message : String(err))
      }
    })
    const summary = await streamTextReturnObj.text;

    const summaryTokens = estimateTokens(summary, invocation.modelId)

    return {
      text: `[Summarized — original was ~${originalTokens} tokens]\n\n${summary}`,
      wasSummarized: true,
      originalTokens,
      summaryTokens,
      tokensFreed: originalTokens - summaryTokens,
    }
  } catch (error) {
    const err = error as Error & { cause?: unknown }
    console.error('[Summarizer] Failed to summarize tool result:', {
      toolName,
      mode: policy.mode,
      threshold,
      originalTokens,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      cause: err?.cause ? String(err.cause) : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    })
    // Truncate if summarization fails rather than losing all content
    const truncated = toolResult.slice(0, policy.truncateMaxChars)
    const truncTokens = estimateTokens(truncated, invocation.modelId)
    return {
      text: `[Truncated from ${originalTokens} tokens]\n\n${truncated}`,
      wasSummarized: true,
      originalTokens,
      summaryTokens: truncTokens,
      tokensFreed: originalTokens - truncTokens,
    }
  }
}

/**
 * Summarizes a JSON object result (tool results are often objects).
 */
export async function maybeSummarizeObjectResult(
  toolName: string,
  result: unknown,
  invocation: ModelInvocationContext,
  userQuery?: string,
  policyOverrides?: Partial<ToolCompactionPolicy>,
  baseSystemPrompt?: string,
): Promise<SummarizeResult & { parsedResult: unknown }> {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  const summarized = await maybeSummarizeToolResult(
    toolName,
    text,
    invocation,
    userQuery,
    policyOverrides,
    baseSystemPrompt,
  )
  return { ...summarized, parsedResult: result }
}
