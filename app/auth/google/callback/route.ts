// ============================================================
// Google OAuth Callback Route
// GET /auth/google/callback
// Exchanges authorization code for tokens, discovers project,
// and stores credentials in the profile config
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { consumeOAuthState } from '@/lib/ai/oauth-state'
import { readConfig, writeConfig } from '@/lib/config/store'
import {
  exchangeGoogleAuthorizationCode,
  getUserEmail,
  discoverProject,
  type GoogleProviderType,
} from '@/lib/ai/google-auth'

function redirectWithCookieClear(url: string, state?: string | null) {
  const res = NextResponse.redirect(url)
  if (state) {
    res.cookies.set(`google_oauth_${state}`, '', { path: '/', maxAge: 0 })
    res.cookies.set(`google_oauth_provider_${state}`, '', { path: '/', maxAge: 0 })
    res.cookies.set(`google_oauth_profile_${state}`, '', { path: '/', maxAge: 0 })
  }
  return res
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const host = req.headers.get('host') ?? 'localhost:1455'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const settingsUrl = `${protocol}://${host}/settings`

  if (error) {
    return redirectWithCookieClear(
      `${settingsUrl}?oauth_error=${encodeURIComponent(errorDescription ?? error)}&oauth_provider=google`,
      state,
    )
  }
  if (!code || !state) {
    return redirectWithCookieClear(`${settingsUrl}?oauth_error=missing_params&oauth_provider=google`, state)
  }

  // Recover code verifier from cookie or in-memory store
  let codeVerifier: string | null = null
  const verifierCookie = req.cookies.get(`google_oauth_${state}`)?.value
  if (verifierCookie) {
    codeVerifier = verifierCookie
  }
  if (!codeVerifier) {
    codeVerifier = consumeOAuthState(state)
  }
  if (!codeVerifier) {
    return redirectWithCookieClear(`${settingsUrl}?oauth_error=invalid_state&oauth_provider=google`, state)
  }

  // Recover provider type from cookie
  const providerType = (req.cookies.get(`google_oauth_provider_${state}`)?.value ?? 'google-gemini-cli') as GoogleProviderType
  const targetProfileId = req.cookies.get(`google_oauth_profile_${state}`)?.value

  try {
    // Exchange code for tokens
    const tokens = await exchangeGoogleAuthorizationCode(code, codeVerifier, providerType)

    // Discover project
    const projectId = await discoverProject(tokens.accessToken, providerType)

    // Get user email
    const email = await getUserEmail(tokens.accessToken)

    // Save to config
    const config = await readConfig()
    const defaultProfileId = `${providerType}:oauth`
    const profileId = targetProfileId || defaultProfileId
    const idx = targetProfileId
      ? config.profiles.findIndex((p) => p.id === targetProfileId && p.provider === providerType)
      : config.profiles.findIndex((p) => p.provider === providerType)

    const defaultAllowedModels = providerType === 'google-antigravity'
      ? ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash']
      : ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']

    const providerLabel = providerType === 'google-antigravity' ? 'Antigravity' : 'Gemini CLI'

    if (idx >= 0) {
      config.profiles[idx] = {
        ...config.profiles[idx],
        googleOAuthRefreshToken: tokens.refreshToken,
        googleOAuthAccessToken: tokens.accessToken,
        googleOAuthProjectId: projectId,
        googleOAuthEmail: email,
        googleOAuthExpiresAt: tokens.expiresAt,
      }
    } else {
      config.profiles.push({
        id: profileId,
        provider: providerType,
        displayName: `${providerLabel} OAuth${email ? ` (${email})` : ''}`,
        allowedModels: defaultAllowedModels,
        systemPrompts: [],
        enabled: true,
        googleOAuthRefreshToken: tokens.refreshToken,
        googleOAuthAccessToken: tokens.accessToken,
        googleOAuthProjectId: projectId,
        googleOAuthEmail: email,
        googleOAuthExpiresAt: tokens.expiresAt,
      })
    }

    await writeConfig(config)

    return redirectWithCookieClear(`${settingsUrl}?connected=${providerType}`, state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    return redirectWithCookieClear(
      `${settingsUrl}?oauth_error=${encodeURIComponent(msg)}&oauth_provider=google`,
      state,
    )
  }
}
