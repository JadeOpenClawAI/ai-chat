// ============================================================
// Main Streaming Chat API Route
// POST /api/chat
// ============================================================

import { streamText, type CoreMessage } from 'ai'
import { getLanguageModel, getModelOptions } from '@/lib/ai/providers'
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager'
import { maybeSummarizeToolResult } from '@/lib/ai/summarizer'
import { chatTools } from '@/lib/ai/tools'
import { TOOL_METADATA } from '@/lib/tools/examples'
import type { LLMProvider, StreamAnnotation } from '@/lib/types'
import { z } from 'zod'

// ── Request schema ───────────────────────────────────────────

const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([
        z.string(),
        z.array(z.record(z.unknown())),
      ]),
    }),
  ),
  provider: z.enum(['anthropic', 'openai', 'codex']).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
})

// ── System prompt ────────────────────────────────────────────

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
Be concise but thorough. Use markdown formatting for structure.`

// ── Route handler ────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const parsed = RequestSchema.safeParse(body)

    if (!parsed.success) {
      return Response.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { messages, provider, model, systemPrompt } = parsed.data

    // ── Read saved config for system prompt ───────────────────
    const { readConfig } = await import('@/lib/config/store')
    const appConfig = await readConfig()

    // Determine effective system prompt:
    // 1. Per-request systemPrompt (highest priority)
    // 2. Provider-specific system prompt from config file
    // 3. Global default
    const providerKey = (provider ?? appConfig.defaultProvider ?? 'anthropic') as keyof typeof appConfig.providers
    const savedProviderSystemPrompt = appConfig.providers[providerKey]?.systemPrompt
    const system = systemPrompt ?? savedProviderSystemPrompt ?? DEFAULT_SYSTEM

    // Cast to CoreMessage — the schema is compatible
    let coreMessages = messages as CoreMessage[]

    // ── Context management: compact if near limit ────────────
    const { messages: compactedMessages, wasCompacted, stats } =
      await maybeCompact(coreMessages, system)
    coreMessages = compactedMessages

    // ── Get the model ─────────────────────────────────────────
    const llm = await getLanguageModel(provider as LLMProvider | undefined, model)

    // ── Collect stream annotations ────────────────────────────
    const annotations: StreamAnnotation[] = []

    // Send initial context stats
    annotations.push({
      type: 'context-stats',
      used: stats.used,
      limit: stats.limit,
      percentage: stats.percentage,
      wasCompacted,
    })

    // ── Stream the response ───────────────────────────────────
    const result = streamText({
      model: llm,
      system,
      messages: coreMessages,
      tools: chatTools,
      maxSteps: 10, // Allow multi-step tool use
      onChunk: () => {
        // Could do fine-grained chunk tracking here
      },
      onStepFinish: async ({ toolCalls, toolResults }) => {
        // Process tool results and check if they need summarization
        if (toolCalls && toolResults) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            const tr = toolResults[i]
            if (!tc || !tr) continue

            const toolName = tc.toolName
            const resultStr =
              typeof tr.result === 'string'
                ? tr.result
                : JSON.stringify(tr.result)

            // Check if result needs summarization
            const summarized = await maybeSummarizeToolResult(
              toolName,
              resultStr,
            )

            const annotation: StreamAnnotation = {
              type: 'tool-state',
              toolCallId: tc.toolCallId,
              toolName,
              state: 'done',
              icon: TOOL_METADATA[toolName as keyof typeof TOOL_METADATA]?.icon,
              resultSummarized: summarized.wasSummarized,
            }
            annotations.push(annotation)
          }
        }
      },
      onFinish: ({ usage }) => {
        // Log token usage for monitoring
        if (usage) {
          console.log(
            `[Chat API] Tokens: prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}`,
          )
        }
      },
      experimental_toolCallStreaming: true,
    })

    // Return the data stream response with annotations
    return result.toDataStreamResponse({
      sendUsage: true,
      getErrorMessage: (error) => {
        console.error('[Chat API] Stream error:', error)
        return error instanceof Error ? error.message : 'An error occurred'
      },
      headers: {
        'X-Context-Used': String(stats.used),
        'X-Context-Limit': String(stats.limit),
        'X-Was-Compacted': String(wasCompacted),
      },
    })
  } catch (error) {
    console.error('[Chat API] Fatal error:', error)
    return Response.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

// ── GET: Return available models ──────────────────────────────

export async function GET() {
  const models = getModelOptions()
  const stats = getContextStats([], DEFAULT_SYSTEM)
  return Response.json({ models, contextLimit: stats.limit })
}
