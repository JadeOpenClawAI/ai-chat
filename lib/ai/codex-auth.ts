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

  return createOpenAI({
    apiKey: accessToken,
    baseURL: options?.baseURL ?? 'https://api.openai.com/v1',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options?.extraHeaders ?? {}),
    },
  })
}
