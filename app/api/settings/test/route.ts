import { readConfig } from '@/lib/config/store'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'

export async function POST(req: Request) {
  const { provider, model, profileId } = (await req.json()) as { provider: string; model?: string; profileId?: string }
  const config = await readConfig()
  const selected = profileId
    ? config.profiles.find((p) => p.id === profileId)
    : config.profiles.find((p) => p.provider === provider)

  if (!selected) return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 })

  try {
    let llmModel: LanguageModel

    if (selected.provider === 'anthropic') {
      const normalizeAnthropicBaseURL = (baseURL?: string) => {
        if (!baseURL?.trim()) return undefined
        const trimmed = baseURL.trim().replace(/\/+$/, '')
        return trimmed.includes('/v1') ? trimmed : `${trimmed}/v1`
      }
      const resolvedApiKey = (selected.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim()
      const resolvedAuthToken = selected.claudeAuthToken?.trim()
      const anthropic = createAnthropic({
        apiKey: resolvedApiKey || undefined,
        baseURL: normalizeAnthropicBaseURL(selected.baseUrl),
        headers: {
          ...(selected.extraHeaders ?? {}),
          ...(resolvedAuthToken ? { Authorization: `Bearer ${resolvedAuthToken}` } : {}),
        },
      })
      llmModel = anthropic(model ?? 'claude-haiku-3-5')
    } else if (selected.provider === 'openai') {
      const openai = createOpenAI({
        apiKey: selected.apiKey ?? process.env.OPENAI_API_KEY ?? '',
        baseURL: selected.baseUrl,
        headers: selected.extraHeaders,
        compatibility: 'strict',
      })
      llmModel = openai(model ?? 'gpt-4o-mini')
    } else {
      const { createCodexProvider } = await import('@/lib/ai/codex-auth')
      const requestedModel = model ?? 'gpt-5.3-codex'
      const codexBaseUrl = requestedModel.startsWith('gpt-5.')
        ? 'https://chatgpt.com/backend-api'
        : (selected.baseUrl ?? 'https://api.openai.com/v1')
      const codex = await createCodexProvider(selected, {
        baseURL: codexBaseUrl,
        extraHeaders: selected.extraHeaders,
      })
      llmModel = codex(requestedModel)
    }

    const isCodexGpt5 = selected.provider === 'codex' && (model ?? '').startsWith('gpt-5.')
    const { text, usage } = await generateText({
      model: llmModel,
      system: isCodexGpt5 ? 'You are a coding assistant. Follow instructions exactly.' : undefined,
      providerOptions: isCodexGpt5 ? ({ openai: { instructions: 'You are a coding assistant. Follow instructions exactly.', store: false } } as never) : undefined,
      messages: [{ role: 'user', content: 'Reply with exactly: "Connection OK"' }],
      maxTokens: 20,
    })

    return Response.json({ ok: true, response: text, tokens: usage?.totalTokens ?? 0 })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
