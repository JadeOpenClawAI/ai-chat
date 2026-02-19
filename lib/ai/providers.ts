// ============================================================
// LLM Provider Configuration
// Supports Anthropic Claude + OpenAI + OpenAI Codex (OAuth)
// via Vercel AI SDK
// ============================================================

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LLMProvider, ModelOption } from '@/lib/types'
import { MODEL_OPTIONS } from '@/lib/types'
import { createCodexProvider } from './codex-auth'

// ── Provider instances ──────────────────────────────────────

async function getAnthropicProvider() {
  // Prefer config file over env vars
  const { readConfig } = await import('@/lib/config/store')
  const config = await readConfig()
  const cfg = config.providers.anthropic

  const apiKey = cfg?.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

  return createAnthropic({
    apiKey,
    baseURL: cfg?.baseUrl,
    headers: cfg?.extraHeaders,
  })
}

async function getOpenAIProvider() {
  // Prefer config file over env vars
  const { readConfig } = await import('@/lib/config/store')
  const config = await readConfig()
  const cfg = config.providers.openai

  const apiKey = cfg?.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  return createOpenAI({
    apiKey,
    baseURL: cfg?.baseUrl,
    headers: cfg?.extraHeaders,
    compatibility: 'strict',
  })
}

// ── Model resolution ────────────────────────────────────────

/**
 * Returns a Vercel AI SDK language model instance for the given provider + model.
 * Falls back to DEFAULT_PROVIDER / DEFAULT_MODEL env vars.
 * Async to support Codex OAuth token refresh and config file reads.
 */
export async function getLanguageModel(
  providerOverride?: LLMProvider,
  modelOverride?: string,
) {
  const { readConfig } = await import('@/lib/config/store')
  const config = await readConfig()

  const provider: LLMProvider =
    providerOverride ??
    (config.defaultProvider as LLMProvider) ??
    (process.env.DEFAULT_PROVIDER as LLMProvider) ??
    'anthropic'

  const modelId =
    modelOverride ??
    config.defaultModel ??
    process.env.DEFAULT_MODEL ??
    getDefaultModelForProvider(provider)

  if (provider === 'anthropic') {
    return (await getAnthropicProvider())(modelId)
  } else if (provider === 'openai') {
    return (await getOpenAIProvider())(modelId)
  } else if (provider === 'codex') {
    const codexCfg = config.providers.codex ?? {}
    const codexProvider = await createCodexProvider({
      codexClientId: codexCfg.codexClientId,
      codexClientSecret: codexCfg.codexClientSecret,
      codexRefreshToken: codexCfg.codexRefreshToken,
    })
    return codexProvider(modelId || 'codex-mini-latest')
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }
}

/**
 * Returns a lightweight "fast" model for internal summarization tasks.
 * Uses claude-haiku or gpt-4o-mini to save costs.
 * Async to support config file reads.
 */
export async function getSummarizationModel() {
  const { readConfig } = await import('@/lib/config/store')
  const config = await readConfig()

  const primary =
    (config.defaultProvider as LLMProvider) ??
    (process.env.DEFAULT_PROVIDER as LLMProvider) ??
    'anthropic'

  if (primary === 'anthropic') {
    try {
      return (await getAnthropicProvider())('claude-haiku-3-5')
    } catch {
      // Fall back to openai if anthropic key not set
    }
  }

  return (await getOpenAIProvider())('gpt-4o-mini')
}

// ── Helpers ─────────────────────────────────────────────────

export function getDefaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic') return 'claude-sonnet-4-5'
  if (provider === 'openai') return 'gpt-4o'
  if (provider === 'codex') return 'codex-mini-latest'
  return 'claude-sonnet-4-5'
}

export function getModelOptions(): ModelOption[] {
  const available: ModelOption[] = []
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  const hasCodex =
    !!process.env.OPENAI_CODEX_CLIENT_ID &&
    !!process.env.OPENAI_CODEX_CLIENT_SECRET &&
    !!process.env.OPENAI_CODEX_REFRESH_TOKEN

  for (const model of MODEL_OPTIONS) {
    if (model.provider === 'anthropic' && hasAnthropic) available.push(model)
    if (model.provider === 'openai' && hasOpenAI) available.push(model)
    if (model.provider === 'codex' && hasCodex) available.push(model)
  }

  // If no keys at all, return all models (will error at request time)
  return available.length > 0 ? available : MODEL_OPTIONS
}

export function getModelInfo(modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === modelId)
}

export function getContextWindowForModel(modelId: string): number {
  const info = getModelInfo(modelId)
  if (info) return info.contextWindow
  // Conservative fallback
  return 128000
}
