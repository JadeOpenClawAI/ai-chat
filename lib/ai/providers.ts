/* eslint-disable max-len */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LLMProvider, ModelOption } from '@/lib/types';
import { MODEL_OPTIONS } from '@/lib/types';
import { createCodexProvider, extractAccountId, refreshCodexToken } from './codex-auth';
import { refreshAnthropicToken } from './anthropic-auth';
import { refreshGoogleToken } from './google-auth';
import { makeGeminiCliCodeAssistFetch } from './google-gemini-cli-api';
import { normalizeGoogleModelId } from './google-models';
import { createRetryingFetch } from './retrying-fetch';
import { createAnthropicCompatFetch } from './anthropic-compat-fetch';
import { readConfig, type ProfileConfig } from '@/lib/config/store';
import https from 'https';
import { Agent as UndiciAgent } from 'undici';

type MastraLanguageModel = unknown;

function makeInsecureFetch() {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const dispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, {
      ...(init ?? {}),
      // Support both node-fetch-style and undici-style custom TLS transports.
      // @ts-expect-error node-fetch agent option
      agent,
      dispatcher,
    });
}

function normalizeAnthropicBaseURL(baseURL?: string): string | undefined {
  if (!baseURL?.trim()) {
    return undefined;
  }
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  return trimmed.includes('/v1') ? trimmed : `${trimmed}/v1`;
}

function modelProviderForProfileProvider(provider: LLMProvider): LLMProvider {
  if (provider === 'anthropic-oauth') {
    return 'anthropic';
  }
  // Google providers map models from their own MODEL_OPTIONS entries directly
  return provider;
}

function isAnthropicOAuthToken(token?: string): boolean {
  return typeof token === 'string' && token.startsWith('sk-ant-oat01-');
}

function mergeAnthropicBetaHeader(existing?: string): string {
  const values = (existing ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.includes('oauth-2025-04-20')) {
    values.push('oauth-2025-04-20');
  }
  return values.join(',');
}

export interface ModelInvocationContext {
  model: MastraLanguageModel;
  provider: LLMProvider;
  modelId: string;
}

export function getDefaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic' || provider === 'anthropic-oauth') {
    return 'claude-sonnet-4-5';
  }
  if (provider === 'openai') {
    return 'gpt-4o';
  }
  if (provider === 'xai') {
    return 'grok-4-1-fast-non-reasoning';
  }
  if (provider === 'google-antigravity') {
    return 'gemini-2.5-pro';
  }
  if (provider === 'google-gemini-cli') {
    return 'auto-gemini-3';
  }
  return 'gpt-5.3-codex';
}

export function getModelOptions(): ModelOption[] {
  return MODEL_OPTIONS;
}

export function getModelInfo(modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === modelId);
}

export function getContextWindowForModel(modelId: string): number {
  return getModelInfo(modelId)?.contextWindow ?? 128000;
}

export function getModelsForProfile(profile: ProfileConfig): ModelOption[] {
  const providerModels = MODEL_OPTIONS.filter((m) => m.provider === modelProviderForProfileProvider(profile.provider));
  if (profile.allowedModels.length === 0) {
    return providerModels;
  }
  return providerModels.filter((m) => profile.allowedModels.includes(m.id));
}

async function modelFromProfile(profile: ProfileConfig, modelId: string): Promise<MastraLanguageModel> {
  if (profile.provider === 'anthropic' || profile.provider === 'anthropic-oauth') {
    const isAnthropicOAuthProvider = profile.provider === 'anthropic-oauth';
    const configuredApiKey = isAnthropicOAuthProvider
      ? undefined
      : (profile.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
    const configuredAuthToken = profile.claudeAuthToken?.trim();
    let oauthAccessToken: string | undefined;
    let oauthRefreshError: Error | undefined;
    if (profile.anthropicOAuthRefreshToken) {
      try {
        oauthAccessToken = await refreshAnthropicToken({
          id: profile.id,
          claudeAuthToken: profile.claudeAuthToken,
          anthropicOAuthExpiresAt: profile.anthropicOAuthExpiresAt,
          anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
        });
      } catch (err) {
        oauthRefreshError = err instanceof Error ? err : new Error(String(err));
      }
    }
    const oauthTokenFromApiKey = !isAnthropicOAuthProvider && isAnthropicOAuthToken(configuredApiKey)
      ? configuredApiKey
      : undefined;
    const resolvedAuthToken = oauthAccessToken || configuredAuthToken || oauthTokenFromApiKey;
    const resolvedApiKey = resolvedAuthToken ? 'oauth-token-via-authorization-header' : configuredApiKey;
    const needsOAuthBetaHeader =
      isAnthropicOAuthProvider ||
      !!oauthAccessToken ||
      !!oauthTokenFromApiKey ||
      isAnthropicOAuthToken(configuredAuthToken);

    if (!resolvedAuthToken && oauthRefreshError) {
      throw oauthRefreshError;
    }
    if (isAnthropicOAuthProvider && !resolvedAuthToken) {
      throw new Error('Anthropic OAuth access token not configured. Connect Anthropic OAuth first.');
    }

    const baseHeaders: Record<string, string> = { ...(profile.extraHeaders ?? {}) };
    if (needsOAuthBetaHeader) {
      const existingBeta = Object.entries(baseHeaders).find(([key]) => key.toLowerCase() === 'anthropic-beta')?.[1];
      for (const key of Object.keys(baseHeaders)) {
        if (key.toLowerCase() === 'anthropic-beta') {
          delete baseHeaders[key];
        }
      }
      baseHeaders['anthropic-beta'] = mergeAnthropicBetaHeader(existingBeta);
    }
    const anthropicHeaders: Record<string, string> = {
      ...baseHeaders,
      ...(resolvedAuthToken ? { Authorization: `Bearer ${resolvedAuthToken}` } : {}),
    };

    const anthropicFetch = resolvedAuthToken
      ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.delete('x-api-key');
        return fetch(input, { ...(init ?? {}), headers });
      }
      : undefined;

    const insecureFetch = profile.rejectUnauthorized === false ? makeInsecureFetch() : undefined;
    const resolvedFetch = anthropicFetch ?? insecureFetch;
    // If both are needed (oauth + insecure), chain them
    const chainedFetch = anthropicFetch && insecureFetch
      ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.delete('x-api-key');
        return insecureFetch(input, { ...(init ?? {}), headers });
      }
      : resolvedFetch;
    const anthropicCompatFetch = createAnthropicCompatFetch(createRetryingFetch(chainedFetch));

    const client = createAnthropic({
      apiKey: resolvedApiKey || undefined,
      baseURL: normalizeAnthropicBaseURL(profile.baseUrl),
      headers: anthropicHeaders,
      fetch: anthropicCompatFetch,
    });
    return client(modelId);
  }

  if (profile.provider === 'openai') {
    const baseFetch = profile.rejectUnauthorized === false ? makeInsecureFetch() : undefined;
    const client = createOpenAI({
      apiKey: profile.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: profile.baseUrl,
      headers: profile.extraHeaders,
      fetch: createRetryingFetch(baseFetch),
    });
    // Default to Chat Completions for custom base URLs (e.g. OpenRouter) since they
    // typically don't support the Responses API. useResponsesApi overrides this.
    const useResponses = profile.useResponsesApi ?? !profile.baseUrl;
    return useResponses ? client(modelId) : client.chat(modelId);
  }

  if (profile.provider === 'xai') {
    const baseFetch = profile.rejectUnauthorized === false ? makeInsecureFetch() : undefined;
    const client = createOpenAI({
      apiKey: profile.apiKey ?? process.env.XAI_API_KEY,
      baseURL: profile.baseUrl ?? 'https://api.x.ai/v1',
      headers: profile.extraHeaders,
      fetch: createRetryingFetch(baseFetch),
    });
    // xAI uses the Chat Completions API, not the OpenAI Responses API.
    return client.chat(modelId);
  }

  if (profile.provider === 'google-antigravity' || profile.provider === 'google-gemini-cli') {
    const accessToken = await refreshGoogleToken({
      id: profile.id,
      googleOAuthRefreshToken: profile.googleOAuthRefreshToken,
      googleOAuthAccessToken: profile.googleOAuthAccessToken,
      googleOAuthProjectId: profile.googleOAuthProjectId,
      googleOAuthExpiresAt: profile.googleOAuthExpiresAt,
      provider: profile.provider,
    });

    const projectId = profile.googleOAuthProjectId;
    if (!projectId) {
      throw new Error('Google Cloud project ID not configured. Re-connect Google OAuth.');
    }

    const isGeminiCliProvider = profile.provider === 'google-gemini-cli';
    const resolvedModelId = isGeminiCliProvider ? normalizeGoogleModelId(modelId) : modelId;
    const baseFetch = isGeminiCliProvider
      ? makeGeminiCliCodeAssistFetch(projectId, normalizeGoogleModelId)
      : undefined;
    const client = createGoogleGenerativeAI({
      apiKey: '', // Not used — we override via headers
      // @ai-sdk/google appends `/models/{model}` to baseURL internally.
      // Gemini CLI mode rewrites requests to Cloud Code Assist at fetch-layer.
      baseURL: isGeminiCliProvider
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/publishers/google`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(profile.extraHeaders ?? {}),
      },
      fetch: createRetryingFetch(baseFetch),
    });
    return client(resolvedModelId);
  }

  const useChatGptBackend = modelId.startsWith('gpt-5.');
  const codexBaseFetch = profile.rejectUnauthorized === false ? makeInsecureFetch() : undefined;
  const codexFetch = createRetryingFetch(codexBaseFetch);

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
    });

    const accountId = extractAccountId(accessToken);

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
      fetch: codexFetch,
    });

    const responsesModel = (codexProvider as unknown as { responses?: (id: string) => MastraLanguageModel }).responses?.(modelId);
    if (responsesModel) {
      return responsesModel;
    }
    // Fallback: try chat completions path (may fail on chatgpt backend, but avoids silent 403)
    return codexProvider(modelId);
  }

  // Non-gpt-5.* models via the standard OpenAI API
  const codexProvider = await createCodexProvider({
    codexClientId: profile.codexClientId,
    codexClientSecret: profile.codexClientSecret,
    codexRefreshToken: profile.codexRefreshToken,
  }, {
    baseURL: profile.baseUrl ?? 'https://api.openai.com/v1',
    extraHeaders: profile.extraHeaders,
    fetch: codexFetch,
  });
  return codexProvider(modelId);
}

export async function getLanguageModelForProfile(profileOrId: ProfileConfig | string, modelId: string): Promise<{ model: MastraLanguageModel; profile: ProfileConfig; modelId: string }> {
  const profile = typeof profileOrId === 'string'
    ? (await readConfig()).profiles.find((p) => p.id === profileOrId && p.enabled)
    : profileOrId;

  if (!profile) {
    throw new Error('Profile not found');
  }

  if (profile.allowedModels.length > 0 && !profile.allowedModels.includes(modelId)) {
    throw new Error(`Model ${modelId} not allowed for profile ${profile.id}`);
  }

  const model = await Promise.race([
    modelFromProfile(profile, modelId),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Provider resolution timed out for ${profile.id}/${modelId}`)), 10_000),
    ),
  ]);
  return { model, profile, modelId };
}

export function getProviderOptionsForCall(
  invocation: Pick<ModelInvocationContext, 'provider' | 'modelId'>,
  systemPrompt: string,
): never | undefined {
  const isCodexGpt5 = invocation.provider === 'codex' && invocation.modelId.startsWith('gpt-5.');
  if (!isCodexGpt5) {
    return undefined;
  }
  return { openai: { instructions: systemPrompt, store: false } } as never;
}
