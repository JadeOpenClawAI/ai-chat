import { readConfig, writeConfig } from '@/lib/config/store';
import { createRetryingFetch } from './retrying-fetch';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface AnthropicOAuthCredentials {
  id?: string;
  claudeAuthToken?: string;
  anthropicOAuthExpiresAt?: number;
  anthropicOAuthRefreshToken?: string;
}

const OAUTH_CLIENT_ID_B64 = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl';
export const DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID = Buffer.from(OAUTH_CLIENT_ID_B64, 'base64').toString('utf8');
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const ANTHROPIC_OAUTH_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference'] as const;
export const DEFAULT_ANTHROPIC_OAUTH_REDIRECT_URI = 'http://localhost:1455/callback';
export const DEFAULT_ANTHROPIC_OAUTH_TIMEOUT_MS = 30_000;

function nonEmpty(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '***') {
    return undefined;
  }
  return trimmed;
}

export function resolveAnthropicOAuthClientId(): string {
  return nonEmpty(process.env.ANTHROPIC_OAUTH_CLIENT_ID) ?? DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID;
}

export function resolveAnthropicOAuthRedirectUri(): string {
  return nonEmpty(process.env.ANTHROPIC_OAUTH_REDIRECT_URI) ?? DEFAULT_ANTHROPIC_OAUTH_REDIRECT_URI;
}

export function resolveAnthropicOAuthRefreshToken(overrides?: AnthropicOAuthCredentials): string | undefined {
  return nonEmpty(overrides?.anthropicOAuthRefreshToken) ?? nonEmpty(process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN);
}

export function resolveAnthropicOAuthTimeoutMs(): number {
  const raw = nonEmpty(process.env.ANTHROPIC_OAUTH_TIMEOUT_MS);
  if (!raw) {
    return DEFAULT_ANTHROPIC_OAUTH_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANTHROPIC_OAUTH_TIMEOUT_MS;
}

const tokenCache = new Map<string, TokenCache>();
const oauthFetch = createRetryingFetch();

function getCacheKey(overrides?: AnthropicOAuthCredentials): string {
  return overrides?.id ?? resolveAnthropicOAuthRefreshToken(overrides) ?? 'anthropic-oauth';
}

export function clearAnthropicTokenCache(overrides?: AnthropicOAuthCredentials): void {
  tokenCache.delete(getCacheKey(overrides));
}

async function persistAnthropicTokens(
  data: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  },
  overrides?: AnthropicOAuthCredentials,
): Promise<void> {
  try {
    const config = await readConfig();
    const providerPreference = ['anthropic-oauth', 'anthropic'] as const;
    const idx = providerPreference
      .map((provider) => (
        overrides?.id
          ? config.profiles.findIndex((p) => p.provider === provider && p.id === overrides.id)
          : config.profiles.findIndex((p) =>
            p.provider === provider &&
              resolveAnthropicOAuthRefreshToken({ anthropicOAuthRefreshToken: p.anthropicOAuthRefreshToken }) ===
                resolveAnthropicOAuthRefreshToken(overrides),
          )
      ))
      .find((candidateIdx) => candidateIdx >= 0) ?? -1;

    if (idx < 0) {
      return;
    }

    config.profiles[idx] = {
      ...config.profiles[idx],
      ...(data.accessToken ? { claudeAuthToken: data.accessToken } : {}),
      ...(data.refreshToken ? { anthropicOAuthRefreshToken: data.refreshToken } : {}),
      ...(data.expiresAt ? { anthropicOAuthExpiresAt: data.expiresAt } : {}),
    };
    await writeConfig(config);
  } catch (err) {
    console.warn('[Anthropic OAuth] Failed to persist tokens:', err);
  }
}

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

async function oauthTokenRequest(body: Record<string, string | undefined>): Promise<OAuthTokenResponse> {
  const cleanBody: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.trim()) {
      cleanBody[key] = value;
    }
  }

  const timeoutMs = resolveAnthropicOAuthTimeoutMs();
  let response: Response;
  try {
    response = await oauthFetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(cleanBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const isTimeoutError =
      (error instanceof DOMException && error.name === 'TimeoutError') ||
      (error instanceof Error && error.name === 'TimeoutError') ||
      message.includes('aborted due to timeout') ||
      message.includes('timeout');

    if (isTimeoutError) {
      throw new Error(
        `Anthropic OAuth token request timed out after ${timeoutMs}ms. ` +
        'Set ANTHROPIC_OAUTH_TIMEOUT_MS to a larger value if your network is slow.',
        { cause: error },
      );
    }
    throw error;
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Anthropic OAuth token request failed: ${response.status} ${details.slice(0, 200)}`);
  }

  return (await response.json()) as OAuthTokenResponse;
}

export async function exchangeAnthropicAuthorizationCode(args: {
  code: string;
  state?: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  return oauthTokenRequest({
    grant_type: 'authorization_code',
    client_id: resolveAnthropicOAuthClientId(),
    code: args.code,
    state: args.state,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
}

export async function refreshAnthropicToken(overrides?: AnthropicOAuthCredentials): Promise<string> {
  const cacheKey = getCacheKey(overrides);
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.accessToken;
  }

  if (
    overrides?.claudeAuthToken &&
    overrides.anthropicOAuthExpiresAt &&
    Date.now() < overrides.anthropicOAuthExpiresAt - 5 * 60 * 1000
  ) {
    tokenCache.set(cacheKey, {
      accessToken: overrides.claudeAuthToken,
      expiresAt: overrides.anthropicOAuthExpiresAt,
    });
    return overrides.claudeAuthToken;
  }

  const refreshToken = resolveAnthropicOAuthRefreshToken(overrides);
  if (!refreshToken) {
    throw new Error('Anthropic OAuth refresh token not configured. Connect Anthropic OAuth first.');
  }

  const data = await oauthTokenRequest({
    grant_type: 'refresh_token',
    client_id: resolveAnthropicOAuthClientId(),
    refresh_token: refreshToken,
    scope: ANTHROPIC_OAUTH_SCOPES.join(' '),
  });

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt,
  });

  await persistAnthropicTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token && data.refresh_token !== refreshToken ? data.refresh_token : undefined,
    expiresAt,
  }, overrides);

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.info('[Anthropic OAuth] Rotated refresh token persisted to profile config');
  }

  return data.access_token;
}
