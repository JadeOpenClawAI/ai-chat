import { streamText, type CoreMessage } from 'ai'
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager'
import { maybeSummarizeToolResult } from '@/lib/ai/summarizer'
import { chatTools } from '@/lib/ai/tools'
import { TOOL_METADATA } from '@/lib/tools/examples'
import type { StreamAnnotation } from '@/lib/types'
import { z } from 'zod'
import { readConfig, writeConfig, getProfileById, composeSystemPrompt, type RouteTarget } from '@/lib/config/store'
import { getLanguageModelForProfile, getModelOptions } from '@/lib/ai/providers'

const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([z.string(), z.array(z.record(z.unknown()))]),
    }),
  ),
  model: z.string().optional(),
  profileId: z.string().optional(),
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

    const { messages, model, profileId, systemPrompt, conversationId } = parsed.data
    const coreMessages = messages as CoreMessage[]
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
    const primaryTarget: RouteTarget = {
      profileId: profileId ?? convoState?.activeProfileId ?? globalPrimary.profileId,
      modelId: model ?? convoState?.activeModelId ?? globalPrimary.modelId,
    }

    const targets: RouteTarget[] = [primaryTarget]
    for (const entry of config.routing.modelPriority) {
      if (!targets.some((t) => t.profileId === entry.profileId && t.modelId === entry.modelId)) {
        targets.push(entry)
      }
    }

    let chosenTarget: RouteTarget | null = null
    let llm: Awaited<ReturnType<typeof getLanguageModelForProfile>>['model'] | null = null
    let chosenProfile = null as ReturnType<typeof getProfileById> | null

    const maxAttempts = Math.max(1, config.routing.maxAttempts)
    const attempts = targets.slice(0, maxAttempts)

    for (const target of attempts) {
      try {
        const resolved = await getLanguageModelForProfile(target.profileId, target.modelId)
        llm = resolved.model
        chosenTarget = { profileId: resolved.profile.id, modelId: resolved.modelId }
        chosenProfile = resolved.profile
        break
      } catch (err) {
        console.warn('[chat] route attempt failed', target, err)
      }
    }

    if (!llm || !chosenTarget || !chosenProfile) {
      return Response.json({ error: 'All route attempts failed. Check profile credentials/models.' }, { status: 500 })
    }

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
        attempt: 1,
        profileId: chosenTarget.profileId,
        provider: chosenProfile.provider,
        model: chosenTarget.modelId,
        status: 'succeeded',
      },
    ]

    const result = streamText({
      model: llm,
      system: effectiveSystem,
      messages: compacted.messages,
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
          annotations.push({
            type: 'tool-state',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            state: 'done',
            icon: TOOL_METADATA[tc.toolName as keyof typeof TOOL_METADATA]?.icon,
            resultSummarized: summarized.wasSummarized,
          })
        }
      },
      experimental_toolCallStreaming: true,
    })

    return result.toDataStreamResponse({
      sendUsage: true,
      getErrorMessage: (error) => (error instanceof Error ? error.message : 'An error occurred'),
      headers: {
        'X-Context-Used': String(compacted.stats.used),
        'X-Context-Limit': String(compacted.stats.limit),
        'X-Was-Compacted': String(compacted.wasCompacted),
        'X-Active-Profile': chosenTarget.profileId,
        'X-Active-Model': chosenTarget.modelId,
      },
    })
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
