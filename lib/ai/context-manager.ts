// ============================================================
// Context & Token Management
// Handles token counting, limits, and conversation compaction
// ============================================================

import type { CoreMessage } from 'ai'
import type { ContextStats } from '@/lib/types'
import { generateText } from 'ai'
import { getSummarizationModel } from './providers'

// ── Configuration ────────────────────────────────────────────

function getConfig() {
  return {
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? '150000', 10),
    compactionThreshold: parseFloat(process.env.COMPACTION_THRESHOLD ?? '0.80'),
    keepRecentMessages: parseInt(process.env.KEEP_RECENT_MESSAGES ?? '10', 10),
  }
}

// ── Token estimation ─────────────────────────────────────────

/**
 * Estimates token count for a string using a simple char-based heuristic.
 * A real implementation would use js-tiktoken for exact counts.
 * Rule of thumb: ~4 chars per token for English text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // Use 3.5 chars/token for code/JSON (denser), 4 for prose
  const charPerToken = text.includes('{') || text.includes('```') ? 3.5 : 4
  return Math.ceil(text.length / charPerToken)
}

/**
 * Estimates token count for a message array.
 * Accounts for role overhead (~4 tokens per message).
 */
export function estimateMessagesTokens(messages: CoreMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += 4 // per-message overhead
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null) {
          if ('text' in part && typeof part.text === 'string') {
            total += estimateTokens(part.text)
          } else if ('type' in part && part.type === 'image') {
            // Images cost roughly 1000-2000 tokens depending on size
            total += 1500
          } else if ('toolResult' in part || 'type' in part) {
            const str = JSON.stringify(part)
            total += estimateTokens(str)
          }
        }
      }
    }
  }
  return total
}

// ── Context stats ─────────────────────────────────────────────

/**
 * Returns context usage statistics for the given messages + system prompt.
 */
export function getContextStats(
  messages: CoreMessage[],
  systemPrompt?: string,
): ContextStats {
  const { maxContextTokens, compactionThreshold } = getConfig()

  let used = estimateMessagesTokens(messages)
  if (systemPrompt) used += estimateTokens(systemPrompt)

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
): Promise<{ messages: CoreMessage[]; summary: string; tokensFreed: number }> {
  const { keepRecentMessages } = getConfig()

  // Need at least keepRecentMessages + some history to compact
  if (messages.length <= keepRecentMessages + 2) {
    return { messages, summary: '', tokensFreed: 0 }
  }

  const originalTokens = estimateMessagesTokens(messages)

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
  const model = getSummarizationModel()
  const { text: summary } = await generateText({
    model,
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
  const compactedTokens = estimateMessagesTokens(compacted)

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
): Promise<{
  messages: CoreMessage[]
  stats: ContextStats
  wasCompacted: boolean
}> {
  const stats = getContextStats(messages, systemPrompt)

  if (!stats.shouldCompact) {
    return { messages, stats, wasCompacted: false }
  }

  try {
    const { messages: compacted } = await compactConversation(
      messages,
      systemPrompt,
    )
    const newStats = getContextStats(compacted, systemPrompt)
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
