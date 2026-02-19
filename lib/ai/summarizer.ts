// ============================================================
// Tool Result Summarizer
// Automatically summarizes large tool results before adding to context
// ============================================================

import { generateText } from 'ai'
import { getSummarizationModel } from './providers'
import { estimateTokens } from './context-manager'

// ── Configuration ─────────────────────────────────────────────

function getSummaryThreshold(): number {
  return parseInt(process.env.TOOL_RESULT_SUMMARY_THRESHOLD ?? '2000', 10)
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
  userQuery?: string,
): Promise<SummarizeResult> {
  const threshold = getSummaryThreshold()
  const originalTokens = estimateTokens(toolResult)

  if (originalTokens <= threshold) {
    return {
      text: toolResult,
      wasSummarized: false,
      originalTokens,
      summaryTokens: originalTokens,
      tokensFreed: 0,
    }
  }

  try {
    const model = getSummarizationModel()
    const contextHint = userQuery
      ? `\n\nUser's current request: "${userQuery}"`
      : ''

    const prompt = `Tool: ${toolName}${contextHint}\n\nRaw output:\n\`\`\`\n${toolResult.slice(0, 50000)}\n\`\`\``

    const { text: summary } = await generateText({
      model,
      system: TOOL_SUMMARY_SYSTEM,
      prompt,
      maxTokens: 1000,
    })

    const summaryTokens = estimateTokens(summary)

    return {
      text: `[Summarized — original was ~${originalTokens} tokens]\n\n${summary}`,
      wasSummarized: true,
      originalTokens,
      summaryTokens,
      tokensFreed: originalTokens - summaryTokens,
    }
  } catch (error) {
    console.error('[Summarizer] Failed to summarize tool result:', error)
    // Truncate if summarization fails rather than losing all content
    const truncated = toolResult.slice(0, 8000)
    const truncTokens = estimateTokens(truncated)
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
  userQuery?: string,
): Promise<SummarizeResult & { parsedResult: unknown }> {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  const summarized = await maybeSummarizeToolResult(toolName, text, userQuery)
  return { ...summarized, parsedResult: result }
}
