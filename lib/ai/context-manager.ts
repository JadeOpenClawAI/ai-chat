// ============================================================
// Context & Token Management
// Handles token counting, limits, and conversation compaction
// Uses js-tiktoken for exact token counts per model
// ============================================================

import type { ModelMessage } from 'ai'
import type { ContextCompactionMode, ContextStats } from '@/lib/types'
import { streamText } from 'ai'
import { getEncoding, type TiktokenEncoding } from 'js-tiktoken'
import type { ModelInvocationContext } from './providers'
import { getProviderOptionsForCall } from './providers'

// ── Configuration ────────────────────────────────────────────

interface ContextConfig {
  maxContextTokens: number
  compactionThreshold: number
  targetContextRatio: number
  keepRecentMessages: number
  minRecentMessages: number
  compactionMode: ContextCompactionMode
  runningSummaryThreshold: number
  summaryMaxTokens: number
  transcriptMaxChars: number
}

export type ContextManagerConfigInput = Partial<{
  maxContextTokens: number
  compactionThreshold: number
  targetContextRatio: number
  keepRecentMessages: number
  minRecentMessages: number
  compactionMode: ContextCompactionMode
  runningSummaryThreshold: number
  summaryMaxTokens: number
  transcriptMaxChars: number
}>

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseIntEnv(raw: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function parseFloatEnv(raw: string | undefined, fallback: number, min = 0, max = 1): number {
  const parsed = parseFloat(raw ?? '')
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function parseCompactionMode(raw: string | undefined): ContextCompactionMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'off' || value === 'disabled' || value === 'none') return 'off'
  if (value === 'truncate' || value === 'dummy' || value === 'drop-oldest') return 'truncate'
  if (value === 'running-summary' || value === 'running' || value === 'rolling-summary') return 'running-summary'
  return 'summary'
}

function normalizeCompactionMode(raw: unknown, fallback: ContextCompactionMode): ContextCompactionMode {
  if (raw === 'off' || raw === 'truncate' || raw === 'summary' || raw === 'running-summary') {
    return raw
  }
  return fallback
}

function getConfig(overrides?: ContextManagerConfigInput): ContextConfig {
  const keepRecentMessages = parseIntEnv(process.env.KEEP_RECENT_MESSAGES, 10, 1, 100)
  const minRecentMessages = parseIntEnv(process.env.MIN_RECENT_MESSAGES, 4, 1, keepRecentMessages)
  const targetContextRatio = parseFloatEnv(process.env.COMPACTION_TARGET_RATIO, 0.1, 0.02, 0.9)

  const compactionThreshold = parseFloatEnv(
    process.env.COMPACTION_THRESHOLD,
    0.75,
    targetContextRatio + 0.05,
    0.98,
  )

  const runningSummaryThreshold = parseFloatEnv(
    process.env.RUNNING_SUMMARY_THRESHOLD,
    0.35,
    targetContextRatio + 0.02,
    compactionThreshold,
  )

  const envConfig: ContextConfig = {
    maxContextTokens: parseIntEnv(process.env.MAX_CONTEXT_TOKENS, 150000, 1024),
    compactionThreshold,
    targetContextRatio,
    keepRecentMessages,
    minRecentMessages,
    compactionMode: parseCompactionMode(process.env.CONTEXT_COMPACTION_MODE),
    runningSummaryThreshold,
    summaryMaxTokens: parseIntEnv(process.env.COMPACTION_SUMMARY_MAX_TOKENS, 1200, 200, 4000),
    transcriptMaxChars: parseIntEnv(process.env.COMPACTION_TRANSCRIPT_MAX_CHARS, 120000, 4000, 500000),
  }

  if (!overrides) return envConfig

  const mergedTargetRatio = clamp(
    overrides.targetContextRatio ?? envConfig.targetContextRatio,
    0.02,
    0.95,
  )
  const mergedThreshold = clamp(
    overrides.compactionThreshold ?? envConfig.compactionThreshold,
    mergedTargetRatio + 0.02,
    0.99,
  )
  const mergedKeepRecent = clamp(
    Math.floor(overrides.keepRecentMessages ?? envConfig.keepRecentMessages),
    1,
    200,
  )
  const mergedMinRecent = clamp(
    Math.floor(overrides.minRecentMessages ?? envConfig.minRecentMessages),
    1,
    mergedKeepRecent,
  )

  return {
    maxContextTokens: clamp(
      Math.floor(overrides.maxContextTokens ?? envConfig.maxContextTokens),
      1024,
      2_000_000,
    ),
    compactionThreshold: mergedThreshold,
    targetContextRatio: mergedTargetRatio,
    keepRecentMessages: mergedKeepRecent,
    minRecentMessages: mergedMinRecent,
    compactionMode: normalizeCompactionMode(overrides.compactionMode, envConfig.compactionMode),
    runningSummaryThreshold: clamp(
      overrides.runningSummaryThreshold ?? envConfig.runningSummaryThreshold,
      mergedTargetRatio + 0.01,
      mergedThreshold,
    ),
    summaryMaxTokens: clamp(
      Math.floor(overrides.summaryMaxTokens ?? envConfig.summaryMaxTokens),
      200,
      4000,
    ),
    transcriptMaxChars: clamp(
      Math.floor(overrides.transcriptMaxChars ?? envConfig.transcriptMaxChars),
      4000,
      500000,
    ),
  }
}

// ── Model → tiktoken encoding map ────────────────────────────

const MODEL_ENCODING_MAP: Record<string, TiktokenEncoding> = {
  // Anthropic models (use cl100k_base — closest approximation)
  'claude-opus-4-5': 'cl100k_base',
  'claude-opus-4-6': 'cl100k_base',
  'claude-sonnet-4-5': 'cl100k_base',
  'claude-sonnet-4-6': 'cl100k_base',
  'claude-haiku-4-5': 'cl100k_base',
  'claude-3-5-sonnet-20241022': 'cl100k_base',
  'claude-3-5-haiku-20241022': 'cl100k_base',
  'claude-3-opus-20240229': 'cl100k_base',
  // OpenAI models — use exact encodings
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'o3-mini': 'o200k_base',
  // Codex
  'gpt-5.3-codex': 'o200k_base',
  'gpt-5.2-codex': 'o200k_base',
  'gpt-5.1-codex-max': 'o200k_base',
  'gpt-5.2': 'o200k_base',
  'gpt-5.1-codex-mini': 'o200k_base',
}

// ── Encoding cache (avoid repeated WASM initialization) ──────

const encodingCache = new Map<TiktokenEncoding, ReturnType<typeof getEncoding>>()

function getCachedEncoding(encodingName: TiktokenEncoding): ReturnType<typeof getEncoding> {
  if (!encodingCache.has(encodingName)) {
    encodingCache.set(encodingName, getEncoding(encodingName))
  }
  return encodingCache.get(encodingName)!
}

// ── Token counting ───────────────────────────────────────────

/**
 * Returns the exact tiktoken count for a string using the appropriate
 * encoding for the given model. Defaults to cl100k_base if model unknown.
 */
export function getTokenCount(text: string, model: string = 'cl100k_base'): number {
  if (!text) return 0
  const encodingName: TiktokenEncoding = MODEL_ENCODING_MAP[model] ?? 'cl100k_base'
  const enc = getCachedEncoding(encodingName)
  return enc.encode(text).length
}

/**
 * Returns the exact tiktoken count for a CoreMessage array.
 * Accounts for per-message overhead (role + formatting tokens).
 */
export function getMessagesTokenCount(messages: ModelMessage[], model: string = 'cl100k_base'): number {
  // Per-message overhead (role + formatting tokens)
  const TOKENS_PER_MESSAGE = 4
  const TOKENS_PER_REPLY = 3

  let total = TOKENS_PER_REPLY
  for (const msg of messages) {
    total += TOKENS_PER_MESSAGE
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content)
    total += getTokenCount(content, model)
  }
  return total
}

/**
 * @deprecated Use getTokenCount() for exact counts.
 * Kept for backwards compatibility with summarizer.ts and other callers.
 * Delegates to getTokenCount with default encoding.
 */
export function estimateTokens(text: string, model: string = 'cl100k_base'): number {
  return getTokenCount(text, model)
}

/**
 * @deprecated Use getMessagesTokenCount() for exact counts.
 * Kept for backwards compatibility.
 */
export function estimateMessagesTokens(messages: ModelMessage[], model: string = 'cl100k_base'): number {
  return getMessagesTokenCount(messages, model)
}

// ── Context stats ─────────────────────────────────────────────

/**
 * Returns context usage statistics for the given messages + system prompt.
 */
export function getContextStats(
  messages: ModelMessage[],
  systemPrompt?: string,
  model: string = 'cl100k_base',
  overrides?: ContextManagerConfigInput,
): ContextStats {
  const { maxContextTokens, compactionThreshold, compactionMode } = getConfig(overrides)

  let used = getMessagesTokenCount(messages, model)
  if (systemPrompt) used += getTokenCount(systemPrompt, model)

  const percentage = used / maxContextTokens
  const shouldCompact = compactionMode !== 'off' && percentage >= compactionThreshold

  return {
    used,
    limit: maxContextTokens,
    percentage,
    shouldCompact,
  }
}

// ── Conversation compaction ───────────────────────────────────

const SUMMARY_PREFIX = '[Conversation Summary]'

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to create a concise but comprehensive summary of the provided conversation history.

The summary should:
1. Capture all important facts, decisions, code snippets, and conclusions
2. Preserve any user preferences, constraints, or ongoing goals
3. Note any tool results that are still relevant
4. Be written in third person as "[Conversation Summary]"
5. Be detailed enough that an AI assistant can continue the conversation without losing context
6. Use markdown formatting for clarity

Do NOT include filler or meta-commentary. Just the summary.`

const COMPACTION_TASK_PROMPT = `Task instructions:
${COMPACTION_SYSTEM_PROMPT}`

function isSummaryMessage(msg: ModelMessage | undefined): msg is ModelMessage & { content: string } {
  if (!msg || msg.role !== 'system') return false
  if (typeof msg.content !== 'string') return false
  return msg.content.startsWith(SUMMARY_PREFIX)
}

function stringifyMessageContent(content: ModelMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2)
}

function buildTranscript(messages: ModelMessage[], maxChars: number): string {
  const full = messages
    .map((msg) => `${msg.role.toUpperCase()}: ${stringifyMessageContent(msg.content)}`)
    .join('\n\n')

  if (full.length <= maxChars) return full
  const head = Math.floor(maxChars * 0.65)
  const tail = Math.max(0, maxChars - head)
  const omitted = full.length - head - tail
  return `${full.slice(0, head)}\n\n...[${omitted} chars omitted]...\n\n${full.slice(-tail)}`
}

function trimToTargetByDroppingOldest(
  messages: ModelMessage[],
  targetTokens: number,
  model: string,
  minMessages: number,
  startIndex: number = 0,
): ModelMessage[] {
  const compacted = [...messages]
  while (compacted.length > minMessages && getMessagesTokenCount(compacted, model) > targetTokens) {
    const dropIndex = Math.min(startIndex, compacted.length - 1)
    compacted.splice(dropIndex, 1)
  }
  return compacted
}

function trimSummaryCompactionToTarget(
  messages: ModelMessage[],
  targetTokens: number,
  model: string,
  minRecentMessages: number,
): ModelMessage[] {
  let compacted = [...messages]
  const hasSummary = isSummaryMessage(compacted[0])
  const minMessages = hasSummary
    ? Math.min(compacted.length, 1 + minRecentMessages)
    : Math.min(compacted.length, minRecentMessages)

  compacted = trimToTargetByDroppingOldest(compacted, targetTokens, model, minMessages, hasSummary ? 1 : 0)
  if (!hasSummary || getMessagesTokenCount(compacted, model) <= targetTokens) return compacted

  const summaryMessage = compacted[0]
  const summaryRaw = summaryMessage?.content
  if (typeof summaryRaw !== 'string') return compacted

  const suffix = '\n\n[Summary truncated to fit context budget.]'
  let body = summaryRaw
  for (let i = 0; i < 8 && body.length > 240; i += 1) {
    body = body.slice(0, Math.floor(body.length * 0.75)).trimEnd()
    const candidate = [
      { ...summaryMessage, content: `${body}${suffix}` } as ModelMessage,
      ...compacted.slice(1),
    ]
    if (getMessagesTokenCount(candidate, model) >= getMessagesTokenCount(compacted, model)) break
    compacted = candidate
    if (getMessagesTokenCount(compacted, model) <= targetTokens) break
  }

  return compacted
}

function getTargetMessageTokens(
  config: ContextConfig,
  systemPrompt: string | undefined,
  model: string,
): number {
  const systemPromptTokens = systemPrompt ? getTokenCount(systemPrompt, model) : 0
  const targetTotalTokens = Math.max(1, Math.floor(config.maxContextTokens * config.targetContextRatio))
  return Math.max(64, targetTotalTokens - systemPromptTokens)
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

async function generateConversationSummary(
  toSummarize: ModelMessage[],
  invocation: ModelInvocationContext,
  baseSystemPrompt: string | undefined,
  maxTokens: number,
  transcriptMaxChars: number,
  existingSummary?: string,
): Promise<string> {
  const transcript = buildTranscript(toSummarize, transcriptMaxChars)
  const existing = existingSummary?.trim()
    ? `Existing summary (carry this forward and update as needed):\n${existingSummary.trim()}\n\n`
    : ''
  const systemForCall = baseSystemPrompt?.trim() || COMPACTION_SYSTEM_PROMPT
  const providerOptions = getProviderOptionsForCall(invocation, systemForCall)
  const useMessages = [
    { role: 'system' as const, content: systemForCall },
    ...(systemForCall != COMPACTION_SYSTEM_PROMPT ? [{ role: 'system' as const, content: COMPACTION_SYSTEM_PROMPT }] : []),
    { role: 'user' as const, content: `${COMPACTION_TASK_PROMPT}\n\n${existing}Please summarize the following conversation:\n\n${transcript}` },
  ];
  const streamTextReturnObj = await streamText({
    model: invocation.model,
    messages: useMessages,
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    ...(providerOptions ? { providerOptions } : {}),
  });
  await streamTextReturnObj.consumeStream({
    onError: err => {
      console.error('[ContextManager] error during summary generation', err instanceof Error ? err.message : String(err))
    }
  })
  const text = await streamTextReturnObj.text;
  return text.trim()
}

interface CompactConversationOptions {
  keepRecentMessages?: number
  targetMessageTokens?: number
  minRecentMessages?: number
}

/**
 * Compacts a message array by summarizing older messages and keeping
 * the N most recent messages verbatim.
 *
 * Returns the compacted message array and the summary text.
 */
export async function compactConversation(
  messages: ModelMessage[],
  invocation: ModelInvocationContext,
  systemPrompt?: string,
  model: string = 'cl100k_base',
  options: CompactConversationOptions = {},
  overrides?: ContextManagerConfigInput,
): Promise<{ messages: ModelMessage[]; summary: string; tokensFreed: number }> {
  const config = getConfig(overrides)
  const keepRecentMessages = clamp(
    options.keepRecentMessages ?? config.keepRecentMessages,
    1,
    Math.max(1, messages.length - 1),
  )
  const minRecentMessages = clamp(
    options.minRecentMessages ?? config.minRecentMessages,
    1,
    keepRecentMessages,
  )
  const targetMessageTokens = options.targetMessageTokens

  // Need at least keepRecentMessages + some history to compact
  if (messages.length <= keepRecentMessages + 1) {
    console.log('[ContextManager] compaction skipped because message count is within keepRecentMessages limit', {
      messageCount: messages.length,
      keepRecentMessages,
    });
    return { messages, summary: '', tokensFreed: 0 }
  }

  const originalTokens = getMessagesTokenCount(messages, model)

  // Split: messages to summarize vs messages to keep verbatim
  const toSummarize = messages.slice(0, messages.length - keepRecentMessages)
  const toKeep = messages.slice(messages.length - keepRecentMessages)

  const existingSummary = isSummaryMessage(toSummarize[0]) ? toSummarize[0].content : undefined
  const summarySource = existingSummary ? toSummarize.slice(1) : toSummarize
  if (summarySource.length === 0 && !existingSummary) {
    return { messages, summary: '', tokensFreed: 0 }
  }

  console.info('[ContextManager] summary compaction started', {
    model,
    messageCount: messages.length,
    keepRecentMessages,
    minRecentMessages,
    summarizeCount: summarySource.length,
    hasExistingSummary: Boolean(existingSummary),
    targetMessageTokens: targetMessageTokens ?? null,
    summaryMaxTokens: config.summaryMaxTokens,
    hasBaseSystemPrompt: Boolean(systemPrompt?.trim()),
    baseSystemPromptChars: systemPrompt?.length ?? 0,
  })

  const summary = await generateConversationSummary(
    summarySource,
    invocation,
    systemPrompt,
    config.summaryMaxTokens,
    config.transcriptMaxChars,
    existingSummary,
  )
  if(!summary || summary.length === 0) {
    console.warn('[ContextManager] generated empty summary, skipping compaction')
    return { messages, summary: '', tokensFreed: 0 }
  };
  // Build compacted message array: summary as system context + recent messages
  const summaryMessage: ModelMessage = {
    role: 'system' as const,
    content: `${SUMMARY_PREFIX}\n\n${summary}`,
  }

  let compacted = [summaryMessage, ...toKeep]
  if (targetMessageTokens && targetMessageTokens > 0) {
    compacted = trimSummaryCompactionToTarget(compacted, targetMessageTokens, model, minRecentMessages)
  }

  const compactedTokens = getMessagesTokenCount(compacted, model)
  const tokensFreed = originalTokens - compactedTokens

  console.info('[ContextManager] summary compaction finished', {
    model,
    originalTokens,
    compactedTokens,
    tokensFreed,
    originalMessageCount: messages.length,
    compactedMessageCount: compacted.length,
    summaryChars: summary.length,
  })

  return {
    messages: compacted,
    summary,
    tokensFreed,
  }
}

/**
 * Checks if compaction is needed and performs it if so.
 * Returns the (possibly compacted) messages and whether compaction occurred.
 */
export async function maybeCompact(
  messages: ModelMessage[],
  invocation: ModelInvocationContext,
  systemPrompt?: string,
  model: string = 'cl100k_base',
  overrides?: ContextManagerConfigInput,
): Promise<{
  messages: ModelMessage[]
  stats: ContextStats
  wasCompacted: boolean
  compactionMode?: ContextCompactionMode
  tokensFreed: number
}> {
  const config = getConfig(overrides)
  const stats = getContextStats(messages, systemPrompt, model, overrides)
  const hasRunningSummary = isSummaryMessage(messages[0])
  const shouldCompactForRunningSummary =
    config.compactionMode === 'running-summary' &&
    hasRunningSummary &&
    stats.percentage >= config.runningSummaryThreshold &&
    messages.length > config.keepRecentMessages + 1

  if (!stats.shouldCompact && !shouldCompactForRunningSummary) {
    return { messages, stats, wasCompacted: false, tokensFreed: 0 }
  }

  const triggerReason = shouldCompactForRunningSummary ? 'running-summary-threshold' : 'context-threshold'
  console.info('[ContextManager] compaction triggered', {
    model,
    mode: config.compactionMode,
    triggerReason,
    usedTokens: stats.used,
    maxContextTokens: stats.limit,
    usageRatio: Number(stats.percentage.toFixed(4)),
    usagePercent: formatRatio(stats.percentage),
    compactionThreshold: config.compactionThreshold,
    compactionThresholdPercent: formatRatio(config.compactionThreshold),
    runningSummaryThreshold: config.runningSummaryThreshold,
    runningSummaryThresholdPercent: formatRatio(config.runningSummaryThreshold),
    messageCount: messages.length,
    keepRecentMessages: config.keepRecentMessages,
    minRecentMessages: config.minRecentMessages,
    hasRunningSummary,
  })

  if (config.compactionMode === 'off') {
    console.info('[ContextManager] compaction skipped because mode is off')
    return { messages, stats: { ...stats, shouldCompact: false }, wasCompacted: false, tokensFreed: 0 }
  }

  const targetMessageTokens = getTargetMessageTokens(config, systemPrompt, model)
  const originalMessageTokens = getMessagesTokenCount(messages, model)

  try {
    let compacted: ModelMessage[] = messages
    let summary = ''

    if (config.compactionMode === 'truncate') {
      const preferredMin = Math.min(messages.length, config.keepRecentMessages)
      compacted = trimToTargetByDroppingOldest(messages, targetMessageTokens, model, preferredMin)
      if (
        getMessagesTokenCount(compacted, model) > targetMessageTokens &&
        preferredMin > config.minRecentMessages
      ) {
        compacted = trimToTargetByDroppingOldest(
          compacted,
          targetMessageTokens,
          model,
          Math.min(compacted.length, config.minRecentMessages),
        )
      }
    } else {
      const compactedResult = await compactConversation(
        messages,
        invocation,
        systemPrompt,
        model,
        {
          keepRecentMessages: config.keepRecentMessages,
          minRecentMessages: config.minRecentMessages,
          targetMessageTokens,
        },
        overrides,
      )
      compacted = compactedResult.messages
      summary = compactedResult.summary
    }

    const compactedMessageTokens = getMessagesTokenCount(compacted, model)
    const tokensFreed = Math.max(0, originalMessageTokens - compactedMessageTokens)
    const didCompact = tokensFreed > 0 || summary.length > 0 || compacted.length < messages.length
    const newStats = getContextStats(compacted, systemPrompt, model, overrides)

    console.info('[ContextManager] compaction result', {
      model,
      mode: config.compactionMode,
      didCompact,
      targetMessageTokens,
      originalMessageTokens,
      compactedMessageTokens,
      tokensFreed,
      originalMessageCount: messages.length,
      compactedMessageCount: compacted.length,
      summaryChars: summary.length,
      newUsedTokens: newStats.used,
      newUsageRatio: Number(newStats.percentage.toFixed(4)),
      newUsagePercent: formatRatio(newStats.percentage),
    })

    return {
      messages: compacted,
      stats: {
        ...newStats,
        wasCompacted: didCompact,
        compactionMode: didCompact ? config.compactionMode : undefined,
        tokensFreed,
      },
      wasCompacted: didCompact,
      compactionMode: didCompact ? config.compactionMode : undefined,
      tokensFreed,
    }
  } catch (error) {
    const err = error as Error & { cause?: unknown }
    console.error('[ContextManager] Compaction failed:', {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      cause: err?.cause ? String(err.cause) : undefined,
      stack: error instanceof Error ? error.stack : undefined,
      model,
      mode: config.compactionMode,
      messageCount: messages.length,
      originalMessageTokens,
      targetMessageTokens,
      usageRatio: Number(stats.percentage.toFixed(4)),
      usagePercent: formatRatio(stats.percentage),
    })
    // Do not force fallback compaction if summary compaction fails.
    return { messages, stats, wasCompacted: false, tokensFreed: 0 }
  }
}
