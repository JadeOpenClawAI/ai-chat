import { NextRequest, NextResponse } from 'next/server'
import { consumeOAuthState } from '@/lib/ai/oauth-state'
import { exchangeAnthropicAuthorizationCode, resolveAnthropicOAuthRedirectUri } from '@/lib/ai/anthropic-auth'
import { readConfig, writeConfig } from '@/lib/config/store'

function redirectWithCookieClear(url: string, state?: string | null) {
  const res = NextResponse.redirect(url)
  if (state) {
    res.cookies.set(`anthropic_oauth_${state}`, '', { path: '/', maxAge: 0 })
    res.cookies.set(`anthropic_oauth_profile_${state}`, '', { path: '/', maxAge: 0 })
  }
  return res
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const host = req.headers.get('host') ?? 'localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const settingsUrl = `${protocol}://${host}/settings`

  if (error) {
    return redirectWithCookieClear(
      `${settingsUrl}?oauth_error=${encodeURIComponent(errorDescription ?? error)}&oauth_provider=anthropic-oauth`,
      state,
    )
  }
  if (!code || !state) {
    return redirectWithCookieClear(`${settingsUrl}?oauth_error=missing_params&oauth_provider=anthropic-oauth`, state)
  }

  let codeVerifier: string | null = null
  const verifierCookie = req.cookies.get(`anthropic_oauth_${state}`)?.value
  if (verifierCookie) {
    codeVerifier = verifierCookie
  }
  if (!codeVerifier) {
    codeVerifier = consumeOAuthState(state)
  }
  if (!codeVerifier) {
    return redirectWithCookieClear(`${settingsUrl}?oauth_error=invalid_state&oauth_provider=anthropic-oauth`, state)
  }

  try {
    const tokens = await exchangeAnthropicAuthorizationCode({
      code,
      state,
      codeVerifier,
      redirectUri: resolveAnthropicOAuthRedirectUri(),
    })

    const config = await readConfig()
    const targetProfileIdRaw = req.cookies.get(`anthropic_oauth_profile_${state}`)?.value
    const targetProfileId = targetProfileIdRaw?.startsWith('anthropic-oauth:') ? targetProfileIdRaw : undefined
    const idx = targetProfileId
      ? config.profiles.findIndex((p) => p.provider === 'anthropic-oauth' && p.id === targetProfileId)
      : config.profiles.findIndex((p) => p.provider === 'anthropic-oauth')

    if (idx >= 0) {
      config.profiles[idx] = {
        ...config.profiles[idx],
        claudeAuthToken: tokens.access_token,
        anthropicOAuthRefreshToken: tokens.refresh_token ?? config.profiles[idx].anthropicOAuthRefreshToken,
      }
    } else {
      config.profiles.push({
        id: targetProfileId || 'anthropic-oauth:oauth',
        provider: 'anthropic-oauth',
        displayName: 'Anthropic OAuth',
        enabled: true,
        extraHeaders: {
          'anthropic-beta': 'oauth-2025-04-20',
        },
        allowedModels: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
        systemPrompts: [],
        claudeAuthToken: tokens.access_token,
        anthropicOAuthRefreshToken: tokens.refresh_token,
      })
    }

    await writeConfig(config)

    return redirectWithCookieClear(`${settingsUrl}?connected=anthropic-oauth`, state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    return redirectWithCookieClear(
      `${settingsUrl}?oauth_error=${encodeURIComponent(msg)}&oauth_provider=anthropic-oauth`,
      state,
    )
  }
}
