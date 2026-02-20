import { readConfig, writeConfig } from '@/lib/config/store'

interface TokenCache {
  accessToken: string
  expiresAt: number
}

export interface AnthropicOAuthCredentials {
  id?: string
  anthropicOAuthRefreshToken?: string
}

const OAUTH_CLIENT_ID_B64 = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'
export const DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID = Buffer.from(OAUTH_CLIENT_ID_B64, 'base64').toString('utf8')
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const ANTHROPIC_OAUTH_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference'] as const
export const DEFAULT_ANTHROPIC_OAUTH_REDIRECT_URI = 'http://localhost:1455/callback'

function nonEmpty(value?: string | null): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === '***') return undefined
  return trimmed
}

export function resolveAnthropicOAuthClientId(): string {
  return nonEmpty(process.env.ANTHROPIC_OAUTH_CLIENT_ID) ?? DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID
}

export function resolveAnthropicOAuthClientSecret(): string | undefined {
  return nonEmpty(process.env.ANTHROPIC_OAUTH_CLIENT_SECRET)
}

export function resolveAnthropicOAuthRedirectUri(): string {
  return nonEmpty(process.env.ANTHROPIC_OAUTH_REDIRECT_URI) ?? DEFAULT_ANTHROPIC_OAUTH_REDIRECT_URI
}

export function resolveAnthropicOAuthRefreshToken(overrides?: AnthropicOAuthCredentials): string | undefined {
  return nonEmpty(overrides?.anthropicOAuthRefreshToken) ?? nonEmpty(process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN)
}

const tokenCache = new Map<string, TokenCache>()

function getCacheKey(overrides?: AnthropicOAuthCredentials): string {
  return overrides?.id ?? resolveAnthropicOAuthRefreshToken(overrides) ?? 'anthropic-oauth'
}

async function persistRotatedRefreshToken(
  newRefreshToken: string,
  overrides?: AnthropicOAuthCredentials,
): Promise<void> {
  try {
    const config = await readConfig()
    const providerPreference = ['anthropic-oauth', 'anthropic'] as const
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
      .find((candidateIdx) => candidateIdx >= 0) ?? -1

    if (idx < 0) return

    config.profiles[idx] = {
      ...config.profiles[idx],
      anthropicOAuthRefreshToken: newRefreshToken,
    }
    await writeConfig(config)
  } catch (err) {
    console.warn('[Anthropic OAuth] Failed to persist rotated refresh token:', err)
  }
}

type OAuthTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

async function oauthTokenRequest(body: Record<string, string | undefined>): Promise<OAuthTokenResponse> {
  const cleanBody: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.trim()) cleanBody[key] = value
  }

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(cleanBody),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`Anthropic OAuth token request failed: ${response.status} ${details.slice(0, 200)}`)
  }

  return (await response.json()) as OAuthTokenResponse
}

export async function exchangeAnthropicAuthorizationCode(args: {
  code: string
  state?: string
  codeVerifier: string
  redirectUri: string
}): Promise<OAuthTokenResponse> {
  return oauthTokenRequest({
    grant_type: 'authorization_code',
    client_id: resolveAnthropicOAuthClientId(),
    client_secret: resolveAnthropicOAuthClientSecret(),
    code: args.code,
    state: args.state,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  })
}

export async function refreshAnthropicToken(overrides?: AnthropicOAuthCredentials): Promise<string> {
  const cacheKey = getCacheKey(overrides)
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.accessToken
  }

  const refreshToken = resolveAnthropicOAuthRefreshToken(overrides)
  if (!refreshToken) {
    throw new Error('Anthropic OAuth refresh token not configured. Connect Anthropic OAuth first.')
  }

  const data = await oauthTokenRequest({
    grant_type: 'refresh_token',
    client_id: resolveAnthropicOAuthClientId(),
    client_secret: resolveAnthropicOAuthClientSecret(),
    refresh_token: refreshToken,
  })

  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  })

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await persistRotatedRefreshToken(data.refresh_token, overrides)
    console.info('[Anthropic OAuth] Rotated refresh token persisted to profile config')
  }

  return data.access_token
}
