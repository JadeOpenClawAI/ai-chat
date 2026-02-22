import { readConfig } from '@/lib/config/store'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'
import { refreshAnthropicToken } from '@/lib/ai/anthropic-auth'

function normalizeAnthropicBaseURL(baseURL?: string) {
  if (!baseURL?.trim()) return undefined
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  return trimmed.includes('/v1') ? trimmed : `${trimmed}/v1`
}

function isAnthropicOAuthToken(token?: string): boolean {
  return typeof token === 'string' && token.startsWith('sk-ant-oat01-')
}

function mergeAnthropicBetaHeader(existing?: string): string {
  const values = (existing ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (!values.includes('oauth-2025-04-20')) values.push('oauth-2025-04-20')
  return values.join(',')
}

export async function POST(req: Request) {
  const { provider, model, profileId } = (await req.json()) as { provider: string; model?: string; profileId?: string }
  const config = await readConfig()
  const selected = profileId
    ? config.profiles.find((p) => p.id === profileId)
    : config.profiles.find((p) => p.provider === provider)

  if (!selected) return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 })

  try {
    let llmModel: LanguageModel

    if (selected.provider === 'anthropic' || selected.provider === 'anthropic-oauth') {
      const isAnthropicOAuthProvider = selected.provider === 'anthropic-oauth'
      const configuredApiKey = isAnthropicOAuthProvider
        ? undefined
        : (selected.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim()
      const configuredAuthToken = selected.claudeAuthToken?.trim()
      let oauthAccessToken: string | undefined
      let oauthRefreshError: Error | undefined
      if (selected.anthropicOAuthRefreshToken) {
        try {
          oauthAccessToken = await refreshAnthropicToken({
            id: selected.id,
            anthropicOAuthRefreshToken: selected.anthropicOAuthRefreshToken,
          })
        } catch (err) {
          oauthRefreshError = err instanceof Error ? err : new Error(String(err))
        }
      }
      const oauthToken = !isAnthropicOAuthProvider && isAnthropicOAuthToken(configuredApiKey)
        ? configuredApiKey
        : undefined
      const resolvedAuthToken = oauthAccessToken || configuredAuthToken || oauthToken
      const resolvedApiKey = resolvedAuthToken ? 'oauth-token-via-authorization-header' : configuredApiKey
      const needsOAuthBetaHeader =
        isAnthropicOAuthProvider ||
        !!oauthAccessToken ||
        !!oauthToken ||
        isAnthropicOAuthToken(configuredAuthToken)
      if (!resolvedAuthToken && oauthRefreshError) {
        throw oauthRefreshError
      }
      if (isAnthropicOAuthProvider && !resolvedAuthToken) {
        throw new Error('Anthropic OAuth access token not configured. Connect Anthropic OAuth first.')
      }
      const baseHeaders: Record<string, string> = { ...(selected.extraHeaders ?? {}) }
      if (needsOAuthBetaHeader) {
        const existingBeta = Object.entries(baseHeaders).find(([key]) => key.toLowerCase() === 'anthropic-beta')?.[1]
        for (const key of Object.keys(baseHeaders)) {
          if (key.toLowerCase() === 'anthropic-beta') delete baseHeaders[key]
        }
        baseHeaders['anthropic-beta'] = mergeAnthropicBetaHeader(existingBeta)
      }
      const anthropicFetch = resolvedAuthToken
        ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers)
            headers.delete('x-api-key')
            return fetch(input, { ...(init ?? {}), headers })
          }
        : undefined
      const anthropic = createAnthropic({
        apiKey: resolvedApiKey || undefined,
        baseURL: normalizeAnthropicBaseURL(selected.baseUrl),
        headers: {
          ...baseHeaders,
          ...(resolvedAuthToken ? { Authorization: `Bearer ${resolvedAuthToken}` } : {}),
        },
        fetch: anthropicFetch,
      })
      llmModel = anthropic(model ?? 'claude-haiku-4-5')
    } else if (selected.provider === 'openai') {
      const openai = createOpenAI({
        apiKey: selected.apiKey ?? process.env.OPENAI_API_KEY ?? '',
        baseURL: selected.baseUrl,
        headers: selected.extraHeaders,
        compatibility: 'strict',
      })
      llmModel = openai(model ?? 'gpt-4o-mini')
    } else if (selected.provider === 'xai') {
      const xai = createOpenAI({
        apiKey: selected.apiKey ?? process.env.XAI_API_KEY ?? '',
        baseURL: selected.baseUrl ?? 'https://api.x.ai/v1',
        headers: selected.extraHeaders,
        compatibility: 'compatible',
      })
      llmModel = xai(model ?? 'grok-4-1-fast-non-reasoning')
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
