// ============================================================
// OpenAI Codex OAuth Authentication
// Handles OAuth2 token refresh for Codex API access
// ============================================================

import { createOpenAI } from '@ai-sdk/openai'
import { readConfig, writeConfig } from '@/lib/config/store'

interface TokenCache {
  accessToken: string
  expiresAt: number // Unix ms
}

export interface CodexCredentials {
  codexClientId?: string
  codexClientSecret?: string
  codexRefreshToken?: string
}

function extractChatGptAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const accountId = auth?.chatgpt_account_id
    return typeof accountId === 'string' && accountId.trim() ? accountId : undefined
  } catch {
    return undefined
  }
}

function nonEmpty(value?: string | null): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (!v || v === '***') return undefined
  return v
}

export function resolveCodexClientId(overrides?: CodexCredentials): string {
  return (
    nonEmpty(overrides?.codexClientId) ??
    nonEmpty(process.env.OPENAI_CODEX_CLIENT_ID) ??
    DEFAULT_CODEX_CLIENT_ID
  )
}

export function resolveCodexClientSecret(overrides?: CodexCredentials): string | undefined {
  return nonEmpty(overrides?.codexClientSecret) ?? nonEmpty(process.env.OPENAI_CODEX_CLIENT_SECRET)
}

export function resolveCodexRefreshToken(overrides?: CodexCredentials): string | undefined {
  return nonEmpty(overrides?.codexRefreshToken) ?? nonEmpty(process.env.OPENAI_CODEX_REFRESH_TOKEN)
}

let tokenCache: TokenCache | null = null

async function persistRotatedRefreshToken(newRefreshToken: string, overrides?: CodexCredentials): Promise<void> {
  try {
    const config = await readConfig()
    const codexProfiles = config.profiles.filter((p) => p.provider === 'codex')
    if (codexProfiles.length === 0) return

    // Prefer exact credential match; fallback to first codex profile.
    const idx = config.profiles.findIndex((p) =>
      p.provider === 'codex' && (
        (overrides?.codexRefreshToken && p.codexRefreshToken === overrides.codexRefreshToken) ||
        (overrides?.codexClientId && p.codexClientId === overrides.codexClientId)
      ),
    )

    const targetIdx = idx >= 0
      ? idx
      : config.profiles.findIndex((p) => p.provider === 'codex')

    if (targetIdx < 0) return
    config.profiles[targetIdx] = {
      ...config.profiles[targetIdx],
      codexRefreshToken: newRefreshToken,
    }
    await writeConfig(config)
  } catch (err) {
    console.warn('[Codex OAuth] Failed to persist rotated refresh_token:', err)
  }
}

// Public OAuth client id used by the official Codex CLI
export const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// JWT claim path where ChatGPT account metadata lives
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the ChatGPT account ID from an OAuth JWT access token.
 *
 * The chatgpt.com/backend-api requires the `chatgpt-account-id` request
 * header, whose value is the `chatgpt_account_id` field nested under the
 * `https://api.openai.com/auth` claim in the JWT payload.
 *
 * @param token  The raw JWT access token string (three-part, dot-separated).
 * @throws       Error if the token is malformed or the claim is missing.
 */
export function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('not a valid JWT (expected 3 parts)')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined
    const accountId = auth?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new Error(`claim '${JWT_CLAIM_PATH}.chatgpt_account_id' is missing or empty`)
    }
    return accountId.trim()
  } catch (err) {
    throw new Error(
      `extractAccountId: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

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

  const clientId = resolveCodexClientId(overrides)
  const clientSecret = resolveCodexClientSecret(overrides)
  const refreshToken = resolveCodexRefreshToken(overrides)

  if (!refreshToken) {
    throw new Error('Codex OAuth refresh token not configured. Connect Codex OAuth first.')
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  })
  if (clientSecret) params.set('client_secret', clientSecret)

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(10_000),
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

  // Persist rotated refresh_token automatically so OAuth survives reboots.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await persistRotatedRefreshToken(data.refresh_token, overrides)
    console.info('[Codex OAuth] Rotated refresh_token persisted to profile config')
  }

  return tokenCache.accessToken
}

/**
 * Creates a Vercel AI SDK provider instance authenticated via Codex OAuth.
 */
export async function createCodexProvider(
  overrides?: CodexCredentials,
  options?: { baseURL?: string; extraHeaders?: Record<string, string> },
) {
  const accessToken = await refreshCodexToken(overrides)
  const baseURL = options?.baseURL ?? 'https://api.openai.com/v1'
  const accountId = extractChatGptAccountId(accessToken)

  return createOpenAI({
    apiKey: accessToken,
    baseURL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(baseURL.includes('chatgpt.com') ? {
        'User-Agent': 'CodexBar',
        Accept: 'application/json',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      } : {}),
      ...(options?.extraHeaders ?? {}),
    },
  })
}
