import { streamText, type CoreMessage } from 'ai'
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager'
import { maybeSummarizeToolResult } from '@/lib/ai/summarizer'
import { chatTools } from '@/lib/ai/tools'
import { TOOL_METADATA } from '@/lib/tools/examples'
import type { StreamAnnotation } from '@/lib/types'
import { z } from 'zod'

const textDecoder = new TextDecoder()
import { readConfig, writeConfig, getProfileById, composeSystemPrompt, type RouteTarget } from '@/lib/config/store'
import { getLanguageModelForProfile, getModelOptions } from '@/lib/ai/providers'

const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([z.string(), z.array(z.record(z.unknown()))]),
      experimental_attachments: z
        .array(
          z.object({
            url: z.string(),
            contentType: z.string().optional(),
            name: z.string().optional(),
          }),
        )
        .optional(),
    }).passthrough(),
  ),
  model: z.string().optional(),
  profileId: z.string().optional(),
  useManualRouting: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  conversationId: z.string().optional(),
})

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
Be concise but thorough. Use markdown formatting for structure.`

function toCoreMessagesWithAttachments(
  messages: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string | Array<Record<string, unknown>>
    experimental_attachments?: Array<{ url: string; contentType?: string }>
  }>,
): CoreMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !m.experimental_attachments?.length) {
      return m as unknown as CoreMessage
    }

    const parts: Array<Record<string, unknown>> = []
    if (typeof m.content === 'string' && m.content.trim()) {
      parts.push({ type: 'text', text: m.content })
    } else if (Array.isArray(m.content)) {
      parts.push(...m.content)
    }

    for (const a of m.experimental_attachments) {
      if (a.contentType?.startsWith('image/')) {
        parts.push({ type: 'image', image: a.url })
      }
    }

    return {
      role: m.role,
      content: parts.length > 0 ? parts : m.content,
    } as CoreMessage
  })
}

function extractLatestUserText(messages: CoreMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
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
    commandHandled: true,
    message: content,
  })
}

export async function POST(request: Request) {
  try {
    const parsed = RequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { messages, model, profileId, useManualRouting, systemPrompt, conversationId } = parsed.data
    const coreMessages = toCoreMessagesWithAttachments(messages)
    const config = await readConfig()

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
    const manualMode = useManualRouting ?? true
    const primaryTarget: RouteTarget = manualMode
      ? {
          profileId: profileId ?? convoState?.activeProfileId ?? globalPrimary.profileId,
          modelId: model ?? convoState?.activeModelId ?? globalPrimary.modelId,
        }
      : {
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
    const attempts = targets.slice(0, maxAttempts)

    for (let idx = 0; idx < attempts.length; idx += 1) {
      const target = attempts[idx]
      try {
        const resolved = await getLanguageModelForProfile(target.profileId, target.modelId)
        const chosenTarget = { profileId: resolved.profile.id, modelId: resolved.modelId }
        const chosenProfile = resolved.profile

        const effectiveSystem = composeSystemPrompt(chosenProfile, systemPrompt) || DEFAULT_SYSTEM
        const compacted = await maybeCompact(coreMessages, effectiveSystem)

        const annotations: StreamAnnotation[] = [
          {
            type: 'context-stats',
            used: compacted.stats.used,
            limit: compacted.stats.limit,
            percentage: compacted.stats.percentage,
            wasCompacted: compacted.wasCompacted,
          },
          {
            type: 'route-attempt',
            attempt: idx + 1,
            profileId: chosenTarget.profileId,
            provider: chosenProfile.provider,
            model: chosenTarget.modelId,
            status: 'succeeded',
          },
        ]

        const isCodexGpt5 = chosenProfile.provider === 'codex' && chosenTarget.modelId.startsWith('gpt-5.')

        if (conversationId) {
          const prev = config.conversations[conversationId]
          if (!prev || prev.activeProfileId !== chosenTarget.profileId || prev.activeModelId !== chosenTarget.modelId) {
            config.conversations[conversationId] = {
              activeProfileId: chosenTarget.profileId,
              activeModelId: chosenTarget.modelId,
            }
            await writeConfig(config)
          }
        }

        const providerOptions = isCodexGpt5
          ? ({ openai: { instructions: effectiveSystem, store: false } } as never)
          : undefined


        const result = streamText({
          model: resolved.model,
          system: effectiveSystem,
          messages: compacted.messages,
          providerOptions,
          tools: chatTools,
          maxSteps: 10,
          onStepFinish: async ({ toolCalls, toolResults }) => {
            if (!toolCalls || !toolResults) return
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i]
              const tr = toolResults[i]
              if (!tc || !tr) continue
              const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
              const summarized = await maybeSummarizeToolResult(tc.toolName, resultStr)

              const resultObj = tr.result as { error?: unknown } | undefined
              const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined
              const inferredError = resultStr.toLowerCase().includes('error executing tool')
                ? resultStr
                : undefined
              const toolError = explicitError ?? inferredError

              annotations.push({
                type: 'tool-state',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                state: toolError ? 'error' : 'done',
                icon: TOOL_METADATA[tc.toolName as keyof typeof TOOL_METADATA]?.icon,
                resultSummarized: summarized.wasSummarized,
                error: toolError,
              })
            }
          },
          experimental_toolCallStreaming: true,
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

        const candidateResponse = result.toDataStreamResponse({
          sendUsage: true,
          getErrorMessage: formatStreamError,
          headers: {
            'X-Context-Used': String(compacted.stats.used),
            'X-Context-Limit': String(compacted.stats.limit),
            'X-Was-Compacted': String(compacted.wasCompacted),
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

        const [probeBranch, clientBranch] = body.tee()
        const probeReader = probeBranch.getReader()
        try {
          let sawValidStart = false
          let errorSnippet = ''
          const startupDeadline = Date.now() + 3000

          while (Date.now() < startupDeadline) {
            let part: ReadableStreamReadResult<Uint8Array>
            try {
              part = await probeReader.read()
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              throw new Error(`Provider stream startup read failed: ${msg}`)
            }

            if (part.done) break
            if (!part.value) continue

            const chunkText = textDecoder.decode(part.value)
            const lower = chunkText.toLowerCase()

            // Data-stream signals that generation is healthy.
            if (
              lower.includes('text-delta') ||
              lower.includes('tool-call') ||
              lower.includes('reasoning')
            ) {
              sawValidStart = true
              break
            }

            // Provider/startup failures (auth, bad request, invalid model, etc.).
            if (
              lower.includes('invalid_api_key') ||
              lower.includes('authentication') ||
              lower.includes('unauthorized') ||
              lower.includes('forbidden') ||
              lower.includes('bad request') ||
              lower.includes('invalid model') ||
              lower.includes('stream error') ||
              (lower.includes('"error"') && !lower.includes('text-delta'))
            ) {
              errorSnippet = chunkText.slice(0, 400)
              break
            }
          }

          if (!sawValidStart) {
            throw new Error(
              errorSnippet
                ? `Provider stream startup failed: ${errorSnippet}`
                : 'Provider stream startup timed out before first valid chunk',
            )
          }
        } finally {
          await probeReader.cancel().catch(() => {})
        }

        return new Response(clientBranch, {
          status: candidateResponse.status,
          statusText: candidateResponse.statusText,
          headers: candidateResponse.headers,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        routeFailures.push({ profileId: target.profileId, modelId: target.modelId, error: msg })
        console.warn('[chat] route attempt failed', target, err)
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
  const stats = getContextStats([], DEFAULT_SYSTEM)
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
    contextLimit: stats.limit,
  })
}
