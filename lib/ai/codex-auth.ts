// ============================================================
// OpenAI Codex OAuth Authentication
// Handles OAuth2 token refresh for Codex API access
// ============================================================

import { createOpenAI } from '@ai-sdk/openai'

interface TokenCache {
  accessToken: string
  expiresAt: number // Unix ms
}

export interface CodexCredentials {
  codexClientId?: string
  codexClientSecret?: string
  codexRefreshToken?: string
}

let tokenCache: TokenCache | null = null

/**
 * Returns a valid Codex access token, refreshing if expired or missing.
 * Caches the token and pre-emptively refreshes 5 minutes before expiry.
 *
 * @param overrides - Optional credential overrides from the config file.
 *   When provided, these take precedence over environment variables.
 */
export async function refreshCodexToken(overrides?: CodexCredentials): Promise<string> {
  // Check cache first (refresh 5 min before expiry)
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.accessToken
  }

  const clientId = overrides?.codexClientId ?? process.env.OPENAI_CODEX_CLIENT_ID
  const clientSecret = overrides?.codexClientSecret ?? process.env.OPENAI_CODEX_CLIENT_SECRET
  const refreshToken = overrides?.codexRefreshToken ?? process.env.OPENAI_CODEX_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Codex OAuth credentials not configured. Set OPENAI_CODEX_CLIENT_ID, OPENAI_CODEX_CLIENT_SECRET, OPENAI_CODEX_REFRESH_TOKEN',
    )
  }

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Codex token refresh failed: ${response.status} ${error}`)
  }

  const data = (await response.json()) as {
    access_token: string
    expires_in?: number
    refresh_token?: string
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }

  // If a new refresh_token is returned, log it (user should update their env)
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn(
      '[Codex OAuth] New refresh_token issued — update OPENAI_CODEX_REFRESH_TOKEN in .env.local',
    )
    console.warn('[Codex OAuth] New refresh_token:', data.refresh_token)
  }

  return tokenCache.accessToken
}

/**
 * Creates a Vercel AI SDK provider instance authenticated via Codex OAuth.
 */
export async function createCodexProvider(overrides?: CodexCredentials) {
  const accessToken = await refreshCodexToken(overrides)

  return createOpenAI({
    apiKey: accessToken,
    baseURL: 'https://api.openai.com/v1',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
