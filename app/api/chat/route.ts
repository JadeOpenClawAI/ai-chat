import { streamText, type ModelMessage, type UIMessage, stepCountIs, createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter, convertToModelMessages } from 'ai';
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager'
import { maybeSummarizeToolResult, shouldSummarizeToolResult } from '@/lib/ai/summarizer'
import { getChatTools, getToolMetadata } from '@/lib/ai/tools'
import type { StreamAnnotation } from '@/lib/types'
import { z } from 'zod/v3';

const textDecoder = new TextDecoder()
import { readConfig, writeConfig, getProfileById, composeSystemPrompt, upsertConversationRoute, type RouteTarget } from '@/lib/config/store'
import { getLanguageModelForProfile, getModelOptions, getProviderOptionsForCall, type ModelInvocationContext } from '@/lib/ai/providers'
import type { ToolCompactionPolicy } from '@/lib/config/store'

// v5: messages use parts arrays; content is kept optional for backward compat (command messages)
const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([z.string(), z.array(z.record(z.unknown()))]).optional(),
      parts: z.array(z.record(z.unknown())).optional(),
    }).passthrough(),
  ),
  model: z.string().optional(),
  profileId: z.string().optional(),
  useAutoRouting: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  conversationId: z.string().optional(),
});

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
Be concise but thorough. Use markdown formatting for structure.`

/**
 * Converts incoming request messages to ModelMessage[] for streamText.
 * Handles v5 parts-based messages (from DefaultChatTransport sendMessage)
 * and legacy content-based messages (from command handler).
 */
async function toModelMessages(messages: Array<Record<string, unknown>>): Promise<ModelMessage[]> {
  // If messages have parts, they're in v5 UIMessage format — use convertToModelMessages
  const hasPartsFormat = messages.some((m) => Array.isArray(m.parts))
  if (hasPartsFormat) {
    // Ensure all messages have parts (wrap legacy content-only messages)
    // and strip UI-only data-* annotation parts that the model should never see.
    const normalized = messages.map((m) => {
      if (Array.isArray(m.parts)) {
        const modelParts = (m.parts as Array<Record<string, unknown>>).filter(
          (p) => typeof p.type !== 'string' || !p.type.startsWith('data-'),
        )
        return { ...m, parts: modelParts }
      }
      return { ...m, parts: [{ type: 'text', text: String(m.content ?? '') }] }
    })
    return convertToModelMessages(normalized as unknown as UIMessage[])
  }

  // Legacy path: content-only or content + experimental_attachments (v4 format)
  return messages.map((m) => {
    const attachments = m.experimental_attachments as Array<{ url: string; contentType?: string }> | undefined
    if (m.role !== 'user' || !attachments?.length) {
      return m as unknown as ModelMessage
    }
    const parts: Array<Record<string, unknown>> = []
    if (typeof m.content === 'string' && (m.content as string).trim()) {
      parts.push({ type: 'text', text: m.content })
    } else if (Array.isArray(m.content)) {
      parts.push(...(m.content as Array<Record<string, unknown>>))
    }
    for (const a of attachments) {
      if (a.contentType?.startsWith('image/')) {
        parts.push({ type: 'image', image: a.url })
      }
    }
    return { role: m.role, content: parts.length > 0 ? parts : m.content } as ModelMessage
  })
}

function extractLatestUserText(messages: Array<Record<string, unknown> | ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>
    if (msg.role !== 'user') continue
    // v5: extract text from parts
    if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: unknown) => (p as Record<string, unknown>)?.type === 'text')
      return textPart ? String((textPart as Record<string, unknown>).text ?? '').trim() : ''
    }
    // Legacy: content string
    if (typeof msg.content === 'string') return msg.content.trim()
    return ''
  }
  return ''
}

function parseCommand(text: string):
  | { kind: 'profile'; profileId: string }
  | { kind: 'model'; modelId: string }
  | { kind: 'route-primary'; profileId: string; modelId: string }
  | null {
  if (!text.startsWith('/')) return null
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts[0] === '/profile' && parts[1]) return { kind: 'profile', profileId: parts[1] }
  if (parts[0] === '/model' && parts[1]) return { kind: 'model', modelId: parts[1] }
  if (parts[0] === '/route' && parts[1] === 'primary' && parts[2] && parts[3]) {
    return { kind: 'route-primary', profileId: parts[2], modelId: parts[3] }
  }
  return null
}

function jsonMessage(content: string) {
  return Response.json({
    command: true,
    commandHandled: true,
    message: content,
  })
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function toCompactedAnnotationMessages(
  messages: ModelMessage[],
): Extract<StreamAnnotation, { type: 'context-compacted' }>['messages'] {
  return messages
    .filter((m): m is ModelMessage & { role: 'user' | 'assistant' | 'system' } =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => {
      const content =
        typeof m.content === 'string' || Array.isArray(m.content)
          ? m.content
          : stringifyToolResult(m.content)
      return {
        role: m.role,
        content,
      }
    });
}

function wrapToolsForModelThread(
  tools: Awaited<ReturnType<typeof getChatTools>>,
  invocation: ModelInvocationContext,
  toolCompaction: ToolCompactionPolicy,
  effectiveSystem: string,
  userQuery: string,
  emitToolState: (
    toolCallId: string,
    toolName: string,
    state: Extract<StreamAnnotation, { type: 'tool-state' }>['state'],
  ) => void,
  summarizedByToolCallId: Map<string, boolean>,
): Awaited<ReturnType<typeof getChatTools>> {
  const wrapped: Record<string, unknown> = {}

  for (const [toolName, toolDef] of Object.entries(tools as Record<string, unknown>)) {
    if (
      !toolDef ||
      typeof toolDef !== 'object' ||
      typeof (toolDef as { execute?: unknown }).execute !== 'function'
    ) {
      wrapped[toolName] = toolDef
      continue
    }

    const execute = (toolDef as { execute: (args: unknown, context?: unknown) => Promise<unknown> }).execute

    wrapped[toolName] = {
      ...(toolDef as Record<string, unknown>),
      execute: async (args: unknown, context?: unknown) => {
        const toolCallId =
          typeof (context as { toolCallId?: unknown } | undefined)?.toolCallId === 'string'
            ? ((context as { toolCallId: string }).toolCallId)
            : `${toolName}-${Date.now()}`

        const rawResult = await execute(args, context)
        const rawResultText = stringifyToolResult(rawResult)
        const decision = shouldSummarizeToolResult(rawResultText, invocation.modelId, toolCompaction)
        console.info('[chat] tool compaction decision', {
          toolName,
          toolCallId,
          mode: decision.mode,
          tokenCount: decision.tokenCount,
          threshold: decision.threshold,
          shouldCompact: decision.shouldSummarize,
        })

        if (!decision.shouldSummarize) {
          summarizedByToolCallId.set(toolCallId, false)
          return rawResult
        }

        if (decision.mode === 'summary') {
          emitToolState(toolCallId, toolName, 'summarizing')
        }

        const summarized = await maybeSummarizeToolResult(
          toolName,
          rawResultText,
          invocation,
          userQuery,
          toolCompaction,
          effectiveSystem,
        )
        summarizedByToolCallId.set(toolCallId, summarized.wasSummarized)
        console.info('[chat] tool compaction result', {
          toolName,
          toolCallId,
          mode: decision.mode,
          wasCompacted: summarized.wasSummarized,
          originalTokens: summarized.originalTokens,
          compactedTokens: summarized.summaryTokens,
          tokensFreed: summarized.tokensFreed,
        })

        return summarized.wasSummarized ? summarized.text : rawResult
      },
    }
  }

  return wrapped as Awaited<ReturnType<typeof getChatTools>>
}

export async function POST(request: Request) {
  try {
    const parsed = RequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { messages, model, profileId, useAutoRouting, systemPrompt, conversationId } = parsed.data
    const coreMessages = await toModelMessages(messages as unknown as Array<Record<string, unknown>>)
    const config = await readConfig()
    const contextManagement = config.contextManagement
    const toolCompaction = config.toolCompaction
    const chatTools = await getChatTools()
    const toolMetadata = await getToolMetadata()

    // Handle command-style messages without LLM call
    const cmd = parseCommand(extractLatestUserText(coreMessages))
    if (cmd && conversationId) {
      if (cmd.kind === 'profile') {
        const profile = getProfileById(config, cmd.profileId)
        if (!profile || !profile.enabled) return jsonMessage(`Profile not found or disabled: ${cmd.profileId}`)
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: profile.allowedModels[0] ?? config.routing.modelPriority[0]?.modelId ?? '',
        }
        await writeConfig(config)
        return jsonMessage(`Switched profile to ${profile.id}`)
      }

      if (cmd.kind === 'model') {
        const state = config.conversations[conversationId]
        const baseProfileId = state?.activeProfileId ?? config.routing.modelPriority[0]?.profileId ?? ''
        const profile = getProfileById(config, baseProfileId)
        if (!profile) return jsonMessage(`No active profile for this conversation.`)
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: cmd.modelId,
        }
        await writeConfig(config)
        return jsonMessage(`Switched model to ${cmd.modelId}`)
      }

      if (cmd.kind === 'route-primary') {
        const profile = getProfileById(config, cmd.profileId)
        if (!profile) return jsonMessage(`Profile not found: ${cmd.profileId}`)
        const newEntry = { profileId: cmd.profileId, modelId: cmd.modelId }
        // Move to front of priority list
        config.routing.modelPriority = [newEntry, ...config.routing.modelPriority.filter((t) => !(t.profileId === newEntry.profileId && t.modelId === newEntry.modelId))]
        await writeConfig(config)
        return jsonMessage(`Updated primary route to ${cmd.profileId} / ${cmd.modelId}`)
      }
    }

    // Determine route targets: per-conversation override > explicit request > global priority list
    const convoState = conversationId ? config.conversations[conversationId] : undefined
    const globalPrimary = config.routing.modelPriority[0] ?? { profileId: config.profiles[0]?.id ?? '', modelId: '' }
    const autoMode = useAutoRouting ?? false
    const primaryTarget: RouteTarget = {
      // Auto mode starts from current auto-selected route (client hint),
      // then conversation state, then global priority head.
      profileId: profileId ?? convoState?.activeProfileId ?? globalPrimary.profileId,
      modelId: model ?? convoState?.activeModelId ?? globalPrimary.modelId,
    }

    const targets: RouteTarget[] = [primaryTarget]
    for (const entry of config.routing.modelPriority) {
      if (!targets.some((t) => t.profileId === entry.profileId && t.modelId === entry.modelId)) {
        targets.push(entry)
      }
    }

    const routeFailures: Array<{ profileId: string; modelId: string; error: string }> = []

    const maxAttempts = Math.max(1, config.routing.maxAttempts)
    const attempts = autoMode ? targets.slice(0, maxAttempts) : [primaryTarget]

    // Cache compaction per effective route+system so retries with identical settings
    // do not repeat expensive summarization work.
    const compactionCache = new Map<string, Awaited<ReturnType<typeof maybeCompact>>>()
    const latestUserQuery = extractLatestUserText(coreMessages)

    for (let idx = 0; idx < attempts.length; idx += 1) {
      const target = attempts[idx]
      const attemptStart = Date.now()
      console.warn(`[chat] route attempt ${idx + 1}/${attempts.length}`, target)

      // Create a per-attempt AbortController so we can cancel orphaned streams
      const attemptController = new AbortController()
      // Per-attempt buffered data parts (flushed into the stream writer once streaming starts)
      const pendingDataParts: Array<{ type: `data-${string}`; id: string; data: StreamAnnotation }> = []
      let streamWriter: UIMessageStreamWriter | undefined

      try {
        const resolved = await getLanguageModelForProfile(target.profileId, target.modelId)
        const chosenTarget = { profileId: resolved.profile.id, modelId: resolved.modelId }
        const chosenProfile = resolved.profile

        const effectiveSystem = composeSystemPrompt(chosenProfile, systemPrompt) || DEFAULT_SYSTEM
        const invocation: ModelInvocationContext = {
          model: resolved.model,
          provider: chosenProfile.provider,
          modelId: chosenTarget.modelId,
        }

        const compactionKey = `${chosenTarget.profileId}:${chosenTarget.modelId}:${effectiveSystem}`
        let compacted = compactionCache.get(compactionKey)
        if (!compacted) {
          compacted = await maybeCompact(coreMessages, invocation, effectiveSystem, chosenTarget.modelId, contextManagement)
          compactionCache.set(compactionKey, compacted)
        }
        console.info('[chat] context compaction check', {
          profileId: chosenTarget.profileId,
          modelId: chosenTarget.modelId,
          configuredMode: contextManagement.mode,
          threshold: contextManagement.compactionThreshold,
          targetRatio: contextManagement.targetContextRatio,
          used: compacted.stats.used,
          limit: compacted.stats.limit,
          usageRatio: Number(compacted.stats.percentage.toFixed(4)),
          shouldCompact: compacted.stats.shouldCompact,
          wasCompacted: compacted.wasCompacted,
          compactionMode: compacted.compactionMode ?? null,
          tokensFreed: compacted.tokensFreed,
        })

        const summarizedByToolCallId = new Map<string, boolean>()
        const lastToolState = new Map<string, string>()

        const emitAnnotation = (annotation: StreamAnnotation) => {
          const part = {
            type: `data-${annotation.type}` as `data-${string}`,
            id: crypto.randomUUID(),
            data: annotation,
          }
          if (streamWriter) {
            streamWriter.write(part)
          } else {
            pendingDataParts.push(part)
          }
        }

        const emitToolState = (
          toolCallId: string,
          toolName: string,
          state: Extract<StreamAnnotation, { type: 'tool-state' }>['state'],
          extra?: Partial<Omit<Extract<StreamAnnotation, { type: 'tool-state' }>, 'type' | 'toolCallId' | 'toolName' | 'state'>>,
        ) => {
          const stateKey = `${state}:${extra?.resultSummarized ?? ''}:${extra?.error ?? ''}`
          if (lastToolState.get(toolCallId) === stateKey) return
          lastToolState.set(toolCallId, stateKey)

          emitAnnotation({
            type: 'tool-state',
            toolCallId,
            toolName,
            state,
            icon: toolMetadata[toolName]?.icon,
            ...extra,
          })
        }

        emitAnnotation({
          type: 'context-stats',
          used: compacted.stats.used,
          limit: compacted.stats.limit,
          percentage: compacted.stats.percentage,
          wasCompacted: compacted.wasCompacted,
          compactionMode: compacted.compactionMode,
          tokensFreed: compacted.tokensFreed,
        })
        if (compacted.wasCompacted) {
          emitAnnotation({
            type: 'context-compacted',
            messages: toCompactedAnnotationMessages(compacted.messages),
          })
        }
        emitAnnotation({
          type: 'route-attempt',
          attempt: idx + 1,
          profileId: chosenTarget.profileId,
          provider: chosenProfile.provider,
          model: chosenTarget.modelId,
          status: 'succeeded',
        })

        if (conversationId) {
          await upsertConversationRoute(conversationId, {
            activeProfileId: chosenTarget.profileId,
            activeModelId: chosenTarget.modelId,
          })
        }

        const providerOptions = getProviderOptionsForCall(invocation, effectiveSystem)
        const toolsForAttempt = wrapToolsForModelThread(
          chatTools,
          invocation,
          toolCompaction,
          effectiveSystem,
          latestUserQuery,
          emitToolState,
          summarizedByToolCallId,
        )


        const result = streamText({
          model: resolved.model,
          system: effectiveSystem,
          maxRetries: 0,
          messages: compacted.messages,
          providerOptions,
          tools: toolsForAttempt,
          stopWhen: stepCountIs(10),
          abortSignal: attemptController.signal,

          onChunk: async ({ chunk }) => {
            if (chunk.type === 'tool-input-start') {
              // v5: tool-input-start uses chunk.id as the toolCallId
              emitToolState(chunk.id, chunk.toolName, 'pending')
            } else if (chunk.type === 'tool-call') {
              emitToolState(chunk.toolCallId, chunk.toolName, 'running')
            }
          },

          onStepFinish: async ({ toolCalls, toolResults }) => {
            if (!toolCalls || !toolResults) return
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i]
              const tr = toolResults[i]
              if (!tc || !tr) continue
              const resultStr = stringifyToolResult(tr.output)

              const resultObj = tr.output as { error?: unknown } | undefined
              const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined
              const inferredError = resultStr.toLowerCase().includes('error executing tool')
                ? resultStr
                : undefined
              const toolError = explicitError ?? inferredError

              emitToolState(tc.toolCallId, tc.toolName, toolError ? 'error' : 'done', {
                resultSummarized: summarizedByToolCallId.get(tc.toolCallId) ?? false,
                error: toolError,
              })
            }
          },
        })

        const formatStreamError = (error: unknown) => {
          const msg = error instanceof Error ? error.message : 'An error occurred'
          const details = error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
                cause: String((error as { cause?: unknown }).cause ?? ''),
                raw: JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
              }
            : { raw: String(error) }
          console.error('[chat] stream error', {
            message: msg,
            profileId: chosenTarget.profileId,
            modelId: chosenTarget.modelId,
            provider: chosenProfile.provider,
            details,
          })
          return msg
        }

        const startupTimeoutMs = 10_000

        // Build the UI message stream and wrap in a Response synchronously — no need for
        // Promise.race here. The actual startup probe happens below on the stream body.
        const uiStream = createUIMessageStream({
          execute: ({ writer }) => {
            streamWriter = writer
            // Flush buffered pre-stream annotations (context-stats, route-attempt, etc.)
            for (const part of pendingDataParts) {
              writer.write(part as never)
            }
            pendingDataParts.length = 0
            writer.merge(result.toUIMessageStream({ onError: formatStreamError }) as unknown as ReadableStream<never>)
          },
          onError: formatStreamError,
        })
        const candidateResponse = createUIMessageStreamResponse({
          stream: uiStream as unknown as ReadableStream<never>,
          headers: {
            'X-Context-Used': String(compacted.stats.used),
            'X-Context-Limit': String(compacted.stats.limit),
            'X-Was-Compacted': String(compacted.wasCompacted),
            'X-Compaction-Configured-Mode': contextManagement.mode,
            'X-Compaction-Threshold': String(contextManagement.compactionThreshold),
            ...(compacted.compactionMode ? { 'X-Compaction-Mode': compacted.compactionMode } : {}),
            ...(compacted.tokensFreed > 0 ? { 'X-Compaction-Tokens-Freed': String(compacted.tokensFreed) } : {}),
            'X-Active-Profile': chosenTarget.profileId,
            'X-Active-Model': chosenTarget.modelId,
            'X-Route-Fallback': String(routeFailures.length > 0),
            ...(routeFailures.length > 0
              ? { 'X-Route-Failures': encodeURIComponent(JSON.stringify(routeFailures.slice(0, 3))) }
              : {}),
          },
        })

        const body = candidateResponse.body
        if (!body) {
          throw new Error('Empty stream body from provider')
        }

        if (autoMode) {
          // AI SDK data-stream prefix codes:
          //   Content:   0: text, g: reasoning, i: redacted_reasoning, j: reasoning_signature
          //   Tool:      b: tool_call_streaming_start, c: tool_call_delta, 9: tool_call, a: tool_result
          //   Lifecycle: f: start_step, e: finish_step, d: finish_message
          //   Metadata:  2: data, 8: message_annotations, h: source, k: file
          //   Error:     3: error
          //
          // The probe keeps reading until it sees a genuine content/tool event
          // (success) or an error event (fallback trigger). Lifecycle/metadata
          // events are neutral — keep probing.
          const CONTENT_PREFIXES = /(?:^|\n)(?:0|g|i|j|b|c|9|a):/
          const ERROR_PREFIX = /(?:^|\n)3:/

          const [probeBranch, clientBranch] = body.tee()
          const probeReader = probeBranch.getReader()
          try {
            const startupDeadline = Date.now() + startupTimeoutMs
            let startupBuffer = ''
            let receivedAnyChunk = false
            let sawContentEvent = false
            while (Date.now() < startupDeadline) {
              let part: ReadableStreamReadResult<Uint8Array>
              try {
                const msLeft = Math.max(1, startupDeadline - Date.now())
                part = await Promise.race([
                  probeReader.read(),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('startup read timeout')), msLeft),
                  ),
                ])
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                throw new Error(`Provider stream startup read failed: ${msg}`)
              }

              if (part.done) break
              if (!part.value) continue

              const chunkText = textDecoder.decode(part.value)
              if (!chunkText) continue

              receivedAnyChunk = true
              startupBuffer = (startupBuffer + chunkText).slice(-4000)
              const lower = startupBuffer.toLowerCase()

              // Check for error prefix or explicit error strings before any content.
              if (
                ERROR_PREFIX.test(startupBuffer) ||
                lower.includes('invalid_api_key') ||
                lower.includes('invalid x-api-key') ||
                lower.includes('authentication') ||
                lower.includes('unauthorized') ||
                lower.includes('forbidden') ||
                lower.includes('bad request') ||
                lower.includes('invalid model') ||
                lower.includes('stream error') ||
                lower.includes('"type":"error"')
              ) {
                throw new Error(`Provider stream startup failed: ${startupBuffer.slice(-500)}`)
              }

              // A real content/tool event means the provider is working — commit.
              if (CONTENT_PREFIXES.test(startupBuffer)) {
                sawContentEvent = true
                break
              }

              // Otherwise it's a lifecycle/metadata-only chunk — keep probing.
            }

            if (!receivedAnyChunk) {
              throw new Error('Provider stream startup timed out before first valid chunk')
            }
            if (!sawContentEvent && receivedAnyChunk) {
              // We got lifecycle/metadata events but never real content before
              // the deadline or stream end. Treat as a startup failure.
              throw new Error(`Provider stream produced no content events within ${startupTimeoutMs}ms: ${startupBuffer.slice(-500)}`)
            }
          } finally {
            // Do not await cancel: some providers keep the stream open and waiting
            // here can block handing the client branch back to the caller.
            void probeReader.cancel().catch(() => {})
          }

          return new Response(clientBranch, {
            status: candidateResponse.status,
            statusText: candidateResponse.statusText,
            headers: candidateResponse.headers,
          })
        }

        return candidateResponse
      } catch (err) {
        attemptController.abort()
        const elapsed = Date.now() - attemptStart
        const msg = err instanceof Error ? err.message : String(err)
        routeFailures.push({ profileId: target.profileId, modelId: target.modelId, error: msg })
        console.warn(`[chat] route attempt ${idx + 1} failed (${elapsed}ms)`, target, err)
      }
    }

    return Response.json({ error: 'All route attempts failed. Check profile credentials/models.', routeFailures }, { status: 500 })
  } catch (error) {
    console.error('[chat] fatal error', error)
    return Response.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 })
  }
}

export async function GET() {
  const config = await readConfig()
  const stats = getContextStats([], DEFAULT_SYSTEM, undefined, config.contextManagement)
  const primary = config.routing.modelPriority[0]
  return Response.json({
    models: getModelOptions(),
    profiles: config.profiles.filter((p) => p.enabled).map((p) => ({
      id: p.id,
      provider: p.provider,
      displayName: p.displayName,
      allowedModels: p.allowedModels,
    })),
    routing: {
      primary: primary ?? { profileId: '', modelId: '' },
      modelPriority: config.routing.modelPriority,
    },
    contextManagement: config.contextManagement,
    contextLimit: stats.limit,
  })
}
