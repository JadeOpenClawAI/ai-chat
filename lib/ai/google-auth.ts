// ============================================================
// Google OAuth Authentication (Antigravity + Gemini CLI)
// Handles OAuth2 token refresh for both Google Cloud AI providers
// ============================================================

import { readConfig, writeConfig } from '@/lib/config/store'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Antigravity OAuth credentials (Gemini 3, Claude, GPT-OSS via Google Cloud)
const ANTIGRAVITY_CLIENT_ID = atob(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
)
const ANTIGRAVITY_CLIENT_SECRET = atob('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=')
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:1455/auth/google/callback'
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

// Gemini CLI OAuth credentials (standard Gemini via Cloud Code Assist)
const GEMINI_CLI_CLIENT_ID = atob(
  'NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t',
)
const GEMINI_CLI_CLIENT_SECRET = atob('R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=')
export const GEMINI_CLI_REDIRECT_URI = 'http://localhost:1455/auth/google/callback'
export const GEMINI_CLI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

// Default fallback project ID when Antigravity project discovery fails
const DEFAULT_ANTIGRAVITY_PROJECT_ID = 'rising-fact-p41fc'

export type GoogleProviderType = 'google-antigravity' | 'google-gemini-cli'

function getClientCredentials(providerType: GoogleProviderType) {
  if (providerType === 'google-antigravity') {
    return {
      clientId: ANTIGRAVITY_CLIENT_ID,
      clientSecret: ANTIGRAVITY_CLIENT_SECRET,
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      scopes: ANTIGRAVITY_SCOPES,
    }
  }
  return {
    clientId: GEMINI_CLI_CLIENT_ID,
    clientSecret: GEMINI_CLI_CLIENT_SECRET,
    redirectUri: GEMINI_CLI_REDIRECT_URI,
    scopes: GEMINI_CLI_SCOPES,
  }
}

export function getGoogleClientId(providerType: GoogleProviderType): string {
  return getClientCredentials(providerType).clientId
}

export function getGoogleScopes(providerType: GoogleProviderType): string[] {
  return getClientCredentials(providerType).scopes
}

export function getGoogleRedirectUri(_providerType: GoogleProviderType): string {
  return 'http://localhost:1455/auth/google/callback'
}

// Per-profile token cache
interface TokenCache {
  accessToken: string
  expiresAt: number
}

const tokenCacheMap = new Map<string, TokenCache>()

export interface GoogleOAuthCredentials {
  id: string
  googleOAuthRefreshToken?: string
  googleOAuthAccessToken?: string
  googleOAuthProjectId?: string
  googleOAuthExpiresAt?: number
  provider: GoogleProviderType
}

async function persistGoogleTokens(
  profileId: string,
  provider: GoogleProviderType,
  tokens: {
    accessToken: string
    refreshToken?: string
    projectId?: string
    expiresAt: number
  },
): Promise<void> {
  try {
    const config = await readConfig()
    const idx = config.profiles.findIndex((p) => p.id === profileId && p.provider === provider)
    if (idx < 0) return
    config.profiles[idx] = {
      ...config.profiles[idx],
      googleOAuthAccessToken: tokens.accessToken,
      googleOAuthExpiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { googleOAuthRefreshToken: tokens.refreshToken } : {}),
      ...(tokens.projectId ? { googleOAuthProjectId: tokens.projectId } : {}),
    }
    await writeConfig(config)
  } catch (err) {
    console.warn(`[Google OAuth] Failed to persist tokens for ${profileId}:`, err)
  }
}

export async function refreshGoogleToken(creds: GoogleOAuthCredentials): Promise<string> {
  const cacheKey = creds.id
  const cached = tokenCacheMap.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.accessToken
  }

  // Check if stored access token is still valid
  if (creds.googleOAuthAccessToken && creds.googleOAuthExpiresAt && Date.now() < creds.googleOAuthExpiresAt - 5 * 60 * 1000) {
    tokenCacheMap.set(cacheKey, {
      accessToken: creds.googleOAuthAccessToken,
      expiresAt: creds.googleOAuthExpiresAt,
    })
    return creds.googleOAuthAccessToken
  }

  const refreshToken = creds.googleOAuthRefreshToken
  if (!refreshToken || refreshToken === '***') {
    throw new Error('Google OAuth refresh token not configured. Connect Google OAuth first.')
  }

  const { clientId, clientSecret } = getClientCredentials(creds.provider)

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Google OAuth token refresh failed: ${response.status} ${error}`)
  }

  const data = (await response.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }

  const expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000

  tokenCacheMap.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt,
  })

  // Persist rotated tokens
  await persistGoogleTokens(creds.id, creds.provider, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token && data.refresh_token !== refreshToken ? data.refresh_token : undefined,
    projectId: creds.googleOAuthProjectId,
    expiresAt,
  })

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.info(`[Google OAuth] Rotated refresh_token persisted for ${creds.id}`)
  }

  return data.access_token
}

export async function exchangeGoogleAuthorizationCode(
  code: string,
  codeVerifier: string,
  providerType: GoogleProviderType,
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: number
}> {
  const { clientId, clientSecret, redirectUri } = getClientCredentials(providerType)

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Google token exchange failed: ${error}`)
  }

  const data = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  if (!data.refresh_token) {
    throw new Error('No refresh token received from Google. Please try again.')
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  }
}

export async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (response.ok) {
      const data = (await response.json()) as { email?: string }
      return data.email
    }
  } catch {
    // Email is optional
  }
  return undefined
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

export async function discoverProject(
  accessToken: string,
  providerType: GoogleProviderType,
): Promise<string> {
  if (providerType === 'google-antigravity') {
    return discoverAntigravityProject(accessToken)
  }
  return discoverGeminiCliProject(accessToken)
}

async function discoverAntigravityProject(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  }

  const endpoints = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ]

  for (const endpoint of endpoints) {
    try {
      const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
      })

      if (loadResponse.ok) {
        const data = (await loadResponse.json()) as LoadCodeAssistPayload
        if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
          return data.cloudaicompanionProject
        }
        if (
          data.cloudaicompanionProject &&
          typeof data.cloudaicompanionProject === 'object' &&
          data.cloudaicompanionProject.id
        ) {
          return data.cloudaicompanionProject.id
        }
      }
    } catch {
      // Try next endpoint
    }
  }

  return DEFAULT_ANTIGRAVITY_PROJECT_ID
}

async function discoverGeminiCliProject(accessToken: string): Promise<string> {
  const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID
  const endpoint = 'https://cloudcode-pa.googleapis.com'

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
  }

  const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      cloudaicompanionProject: envProjectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: envProjectId,
      },
    }),
  })

  if (!loadResponse.ok) {
    // Check for VPC Service Controls
    let errorPayload: unknown
    try {
      errorPayload = await loadResponse.clone().json()
    } catch {
      errorPayload = undefined
    }

    const isVpcSc = errorPayload &&
      typeof errorPayload === 'object' &&
      'error' in errorPayload &&
      (errorPayload as { error?: { details?: Array<{ reason?: string }> } }).error?.details?.some(
        (d) => d.reason === 'SECURITY_POLICY_VIOLATED',
      )

    if (!isVpcSc) {
      const errorText = await loadResponse.text()
      throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${errorText}`)
    }
    // VPC SC user — needs env var project
    if (envProjectId) return envProjectId
    throw new Error(
      'This account requires setting GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
    )
  }

  const data = (await loadResponse.json()) as LoadCodeAssistPayload

  if (data.currentTier) {
    if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
      return data.cloudaicompanionProject
    }
    if (envProjectId) return envProjectId
    throw new Error(
      'This account requires setting GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
    )
  }

  // New user — attempt onboarding with free tier
  const tier = data.allowedTiers?.find((t) => t.isDefault) ?? { id: 'free-tier' }
  const tierId = tier.id ?? 'free-tier'

  if (tierId !== 'free-tier' && !envProjectId) {
    throw new Error(
      'This account requires setting GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
    )
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  }

  if (tierId !== 'free-tier' && envProjectId) {
    onboardBody.cloudaicompanionProject = envProjectId
    ;(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId
  }

  const onboardResponse = await fetch(`${endpoint}/v1internal:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify(onboardBody),
  })

  if (!onboardResponse.ok) {
    const errorText = await onboardResponse.text()
    throw new Error(`onboardUser failed: ${onboardResponse.status} ${errorText}`)
  }

  interface LROResponse {
    name?: string
    done?: boolean
    response?: { cloudaicompanionProject?: { id?: string } }
  }

  let lroData = (await onboardResponse.json()) as LROResponse

  // Poll long-running operation if not done
  if (!lroData.done && lroData.name) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 5000))
      const pollResponse = await fetch(`${endpoint}/v1internal/${lroData.name}`, {
        method: 'GET',
        headers,
      })
      if (!pollResponse.ok) {
        throw new Error(`Failed to poll operation: ${pollResponse.status}`)
      }
      lroData = (await pollResponse.json()) as LROResponse
      if (lroData.done) break
    }
  }

  const projectId = lroData.response?.cloudaicompanionProject?.id
  if (projectId) return projectId
  if (envProjectId) return envProjectId

  throw new Error(
    'Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT env var.',
  )
}
