import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { LLMProvider, ModelOption } from '@/lib/types'
import { MODEL_OPTIONS } from '@/lib/types'
import { createCodexProvider, extractAccountId, refreshCodexToken } from './codex-auth'
import { readConfig, type ProfileConfig } from '@/lib/config/store'

function normalizeAnthropicBaseURL(baseURL?: string): string | undefined {
  if (!baseURL?.trim()) return undefined
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  return trimmed.includes('/v1') ? trimmed : `${trimmed}/v1`
}

export function getDefaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic') return 'claude-sonnet-4-5'
  if (provider === 'openai') return 'gpt-4o'
  return 'gpt-5.3-codex'
}

export function getModelOptions(): ModelOption[] {
  return MODEL_OPTIONS
}

export function getModelInfo(modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === modelId)
}

export function getContextWindowForModel(modelId: string): number {
  return getModelInfo(modelId)?.contextWindow ?? 128000
}

export function getModelsForProfile(profile: ProfileConfig): ModelOption[] {
  const providerModels = MODEL_OPTIONS.filter((m) => m.provider === profile.provider)
  if (profile.allowedModels.length === 0) return providerModels
  return providerModels.filter((m) => profile.allowedModels.includes(m.id))
}

async function modelFromProfile(profile: ProfileConfig, modelId: string): Promise<LanguageModel> {
  if (profile.provider === 'anthropic') {
    const client = createAnthropic({
      apiKey: profile.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: normalizeAnthropicBaseURL(profile.baseUrl),
      headers: profile.extraHeaders,
    })
    return client(modelId)
  }

  if (profile.provider === 'openai') {
    const client = createOpenAI({
      apiKey: profile.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: profile.baseUrl,
      headers: profile.extraHeaders,
      compatibility: 'strict',
    })
    return client(modelId)
  }

  const useChatGptBackend = modelId.startsWith('gpt-5.')

  if (useChatGptBackend) {
    // chatgpt.com/backend-api/codex/responses requires specific headers and a
    // non-standard base URL. The @ai-sdk/openai responses model appends `/responses`
    // to the baseURL, so we set baseURL to .../codex so the final path is correct.
    //
    // Required headers:
    //  - chatgpt-account-id: decoded from the JWT access token
    //  - OpenAI-Beta: responses=experimental
    //  - originator: pi

    const accessToken = await refreshCodexToken({
      codexClientId: profile.codexClientId,
      codexClientSecret: profile.codexClientSecret,
      codexRefreshToken: profile.codexRefreshToken,
    })

    const accountId = extractAccountId(accessToken)

    const codexProvider = await createCodexProvider({
      codexClientId: profile.codexClientId,
      codexClientSecret: profile.codexClientSecret,
      codexRefreshToken: profile.codexRefreshToken,
    }, {
      // KEY FIX #1: endpoint must be /codex/responses, not /responses
      // @ai-sdk/openai appends '/responses', so baseURL needs to end in /codex
      baseURL: 'https://chatgpt.com/backend-api/codex',
      extraHeaders: {
        // KEY FIX #2: required auth header — chatgpt_account_id from JWT claim
        'chatgpt-account-id': accountId,
        // KEY FIX #3: required beta flag for the Responses API on chatgpt backend
        'OpenAI-Beta': 'responses=experimental',
        // KEY FIX #4: expected originator identifier
        'originator': 'pi',
        ...(profile.extraHeaders ?? {}),
      },
    })

    const responsesModel = (codexProvider as unknown as { responses?: (id: string) => LanguageModel }).responses?.(modelId)
    if (responsesModel) return responsesModel
    // Fallback: try chat completions path (may fail on chatgpt backend, but avoids silent 403)
    return codexProvider(modelId)
  }

  // Non-gpt-5.* models via the standard OpenAI API
  const codexProvider = await createCodexProvider({
    codexClientId: profile.codexClientId,
    codexClientSecret: profile.codexClientSecret,
    codexRefreshToken: profile.codexRefreshToken,
  }, {
    baseURL: profile.baseUrl ?? 'https://api.openai.com/v1',
    extraHeaders: profile.extraHeaders,
  })
  return codexProvider(modelId)
}

export async function getLanguageModelForProfile(profileOrId: ProfileConfig | string, modelId: string): Promise<{ model: LanguageModel; profile: ProfileConfig; modelId: string }> {
  const profile = typeof profileOrId === 'string'
    ? (await readConfig()).profiles.find((p) => p.id === profileOrId && p.enabled)
    : profileOrId

  if (!profile) throw new Error('Profile not found')

  if (profile.allowedModels.length > 0 && !profile.allowedModels.includes(modelId)) {
    throw new Error(`Model ${modelId} not allowed for profile ${profile.id}`)
  }

  const model = await modelFromProfile(profile, modelId)
  return { model, profile, modelId }
}

export async function getSummarizationModel() {
  try {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    return anthropic('claude-haiku-3-5')
  } catch {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY, compatibility: 'strict' })
    return openai('gpt-4o-mini')
  }
}
