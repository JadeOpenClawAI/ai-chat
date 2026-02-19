// ============================================================
// Connection Test API Route
// POST — test a provider connection by sending a short completion
// ============================================================

import { readConfig } from '@/lib/config/store'
import type { ProviderConfig } from '@/lib/config/store'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'

export async function POST(req: Request) {
  const { provider, model } = (await req.json()) as {
    provider: string
    model?: string
  }

  const config = await readConfig()
  const providerCfg: ProviderConfig =
    config.providers[provider as keyof typeof config.providers] ?? {}

  try {
    let llmModel: LanguageModel

    if (provider === 'anthropic') {
      const anthropic = createAnthropic({
        apiKey: providerCfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
        baseURL: providerCfg.baseUrl,
        headers: providerCfg.extraHeaders,
      })
      llmModel = anthropic(model ?? 'claude-haiku-3-5')
    } else if (provider === 'openai') {
      const openai = createOpenAI({
        apiKey: providerCfg.apiKey ?? process.env.OPENAI_API_KEY ?? '',
        baseURL: providerCfg.baseUrl,
        headers: providerCfg.extraHeaders,
        compatibility: 'strict',
      })
      llmModel = openai(model ?? 'gpt-4o-mini')
    } else if (provider === 'codex') {
      const { refreshCodexToken } = await import('@/lib/ai/codex-auth')
      const token = await refreshCodexToken({
        codexClientId: providerCfg.codexClientId,
        codexClientSecret: providerCfg.codexClientSecret,
        codexRefreshToken: providerCfg.codexRefreshToken,
      })
      const codex = createOpenAI({
        apiKey: token,
        baseURL: providerCfg.baseUrl ?? 'https://api.openai.com/v1',
        headers: providerCfg.extraHeaders,
      })
      llmModel = codex(model ?? 'codex-mini-latest')
    } else {
      return Response.json({ ok: false, error: 'Unknown provider' }, { status: 400 })
    }

    const { text, usage } = await generateText({
      model: llmModel,
      messages: [{ role: 'user', content: 'Reply with exactly: "Connection OK"' }],
      maxTokens: 20,
    })

    return Response.json({
      ok: true,
      response: text,
      tokens: usage?.totalTokens ?? 0,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 200 })
  }
}
