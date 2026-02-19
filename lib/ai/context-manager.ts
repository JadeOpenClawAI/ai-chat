// ============================================================
// Context & Token Management
// Handles token counting, limits, and conversation compaction
// Uses js-tiktoken for exact token counts per model
// ============================================================

import type { CoreMessage } from 'ai'
import type { ContextStats } from '@/lib/types'
import { generateText } from 'ai'
import { getEncoding, type TiktokenEncoding } from 'js-tiktoken'
import { getSummarizationModel } from './providers'

// ── Configuration ────────────────────────────────────────────

function getConfig() {
  return {
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '150000', 10),
    compactionThreshold: parseFloat(process.env.COMPACTION_THRESHOLD ?? '0.80'),
    keepRecentMessages: parseInt(process.env.KEEP_RECENT_MESSAGES ?? '10', 10),
  }
}

// ── Model → tiktoken encoding map ────────────────────────────

const MODEL_ENCODING_MAP: Record<string, TiktokenEncoding> = {
  // Anthropic models (use cl100k_base — closest approximation)
  'claude-opus-4-5': 'cl100k_base',
  'claude-sonnet-4-5': 'cl100k_base',
  'claude-haiku-4-5': 'cl100k_base',
  'claude-haiku-3-5': 'cl100k_base',
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
export function getMessagesTokenCount(messages: CoreMessage[], model: string = 'cl100k_base'): number {
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
export function estimateMessagesTokens(messages: CoreMessage[], model: string = 'cl100k_base'): number {
  return getMessagesTokenCount(messages, model)
}

// ── Context stats ─────────────────────────────────────────────

/**
 * Returns context usage statistics for the given messages + system prompt.
 */
export function getContextStats(
  messages: CoreMessage[],
  systemPrompt?: string,
  model: string = 'cl100k_base',
): ContextStats {
  const { maxContextTokens, compactionThreshold } = getConfig()

  let used = getMessagesTokenCount(messages, model)
  if (systemPrompt) used += getTokenCount(systemPrompt, model)

  const percentage = used / maxContextTokens
  const shouldCompact = percentage >= compactionThreshold

  return {
    used,
    limit: maxContextTokens,
    percentage,
    shouldCompact,
  }
}

// ── Conversation compaction ───────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to create a concise but comprehensive summary of the provided conversation history.

The summary should:
1. Capture all important facts, decisions, code snippets, and conclusions
2. Preserve any user preferences, constraints, or ongoing goals
3. Note any tool results that are still relevant
4. Be written in third person as "[Conversation Summary]"
5. Be detailed enough that an AI assistant can continue the conversation without losing context
6. Use markdown formatting for clarity

Do NOT include filler or meta-commentary. Just the summary.`

/**
 * Compacts a message array by summarizing older messages and keeping
 * the N most recent messages verbatim.
 *
 * Returns the compacted message array and the summary text.
 */
export async function compactConversation(
  messages: CoreMessage[],
  systemPrompt?: string,
  model: string = 'cl100k_base',
): Promise<{ messages: CoreMessage[]; summary: string; tokensFreed: number }> {
  const { keepRecentMessages } = getConfig()

  // Need at least keepRecentMessages + some history to compact
  if (messages.length <= keepRecentMessages + 2) {
    return { messages, summary: '', tokensFreed: 0 }
  }

  const originalTokens = getMessagesTokenCount(messages, model)

  // Split: messages to summarize vs messages to keep verbatim
  const toSummarize = messages.slice(0, messages.length - keepRecentMessages)
  const toKeep = messages.slice(messages.length - keepRecentMessages)

  // Build a readable transcript for summarization
  const transcript = toSummarize
    .map((msg) => {
      const role = msg.role.toUpperCase()
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content, null, 2)
      return `${role}: ${content}`
    })
    .join('\n\n')

  // Generate summary using a fast/cheap model
  const summarizationModel = await getSummarizationModel()
  const { text: summary } = await generateText({
    model: summarizationModel,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: `Please summarize the following conversation:\n\n${transcript}`,
    maxTokens: 2000,
  })

  // Build compacted message array: summary as system context + recent messages
  const summaryMessage: CoreMessage = {
    role: 'system' as const,
    content: `[Conversation Summary]\n\n${summary}`,
  }

  const compacted = [summaryMessage, ...toKeep]
  const compactedTokens = getMessagesTokenCount(compacted, model)

  return {
    messages: compacted,
    summary,
    tokensFreed: originalTokens - compactedTokens,
  }
}

/**
 * Checks if compaction is needed and performs it if so.
 * Returns the (possibly compacted) messages and whether compaction occurred.
 */
export async function maybeCompact(
  messages: CoreMessage[],
  systemPrompt?: string,
  model: string = 'cl100k_base',
): Promise<{
  messages: CoreMessage[]
  stats: ContextStats
  wasCompacted: boolean
}> {
  const stats = getContextStats(messages, systemPrompt, model)

  if (!stats.shouldCompact) {
    return { messages, stats, wasCompacted: false }
  }

  try {
    const { messages: compacted } = await compactConversation(
      messages,
      systemPrompt,
      model,
    )
    const newStats = getContextStats(compacted, systemPrompt, model)
    return {
      messages: compacted,
      stats: { ...newStats, wasCompacted: true },
      wasCompacted: true,
    }
  } catch (error) {
    console.error('[ContextManager] Compaction failed:', error)
    // Return original messages if compaction fails
    return { messages, stats, wasCompacted: false }
  }
}
