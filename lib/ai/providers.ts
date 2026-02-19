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

function getAnthropicProvider() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set')
  return createAnthropic({ apiKey })
}

function getOpenAIProvider() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set')
  return createOpenAI({ apiKey, compatibility: 'strict' })
}

// ── Model resolution ────────────────────────────────────────

/**
 * Returns a Vercel AI SDK language model instance for the given provider + model.
 * Falls back to DEFAULT_PROVIDER / DEFAULT_MODEL env vars.
 * Async to support Codex OAuth token refresh.
 */
export async function getLanguageModel(
  providerOverride?: LLMProvider,
  modelOverride?: string,
) {
  const provider: LLMProvider =
    providerOverride ??
    (process.env.DEFAULT_PROVIDER as LLMProvider) ??
    'anthropic'

  const modelId =
    modelOverride ??
    process.env.DEFAULT_MODEL ??
    getDefaultModelForProvider(provider)

  if (provider === 'anthropic') {
    return getAnthropicProvider()(modelId)
  } else if (provider === 'openai') {
    return getOpenAIProvider()(modelId)
  } else if (provider === 'codex') {
    const codexProvider = await createCodexProvider()
    return codexProvider(modelId || 'codex-mini-latest')
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }
}

/**
 * Returns a lightweight "fast" model for internal summarization tasks.
 * Uses claude-haiku or gpt-4o-mini to save costs.
 * Synchronous — does not support Codex (no need for summarization via OAuth).
 */
export function getSummarizationModel(): ReturnType<ReturnType<typeof getAnthropicProvider>> {
  const primary = (process.env.DEFAULT_PROVIDER as LLMProvider) ?? 'anthropic'
  if (primary === 'anthropic') {
    try {
      return getAnthropicProvider()('claude-haiku-3-5')
    } catch {
      // Fall back to openai if anthropic key not set
    }
  }
  return getOpenAIProvider()('gpt-4o-mini')
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
