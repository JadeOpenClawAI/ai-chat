// ============================================================
// LLM Provider Configuration
// Supports Anthropic Claude + OpenAI via Vercel AI SDK
// ============================================================

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LLMProvider, ModelOption } from '@/lib/types'
import { MODEL_OPTIONS } from '@/lib/types'

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
 */
export function getLanguageModel(
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
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }
}

/**
 * Returns a lightweight "fast" model for internal summarization tasks.
 * Uses claude-haiku or gpt-4o-mini to save costs.
 */
export function getSummarizationModel(): ReturnType<typeof getLanguageModel> {
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
  return 'claude-sonnet-4-5'
}

export function getModelOptions(): ModelOption[] {
  const available: ModelOption[] = []
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY

  for (const model of MODEL_OPTIONS) {
    if (model.provider === 'anthropic' && hasAnthropic) available.push(model)
    if (model.provider === 'openai' && hasOpenAI) available.push(model)
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
