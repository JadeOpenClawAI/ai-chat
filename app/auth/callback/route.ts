import { NextRequest, NextResponse } from 'next/server'
import { consumeOAuthState } from '@/lib/ai/oauth-state'
import { readConfig, writeConfig } from '@/lib/config/store'
import { resolveCodexClientId, resolveCodexClientSecret } from '@/lib/ai/codex-auth'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'

function redirectWithCookieClear(url: string, state?: string | null) {
  const res = NextResponse.redirect(url)
  if (state) {
    res.cookies.set(`codex_oauth_${state}`, '', { path: '/', maxAge: 0 })
    res.cookies.set(`codex_oauth_profile_${state}`, '', { path: '/', maxAge: 0 })
  }
  // cleanup legacy cookie name too
  res.cookies.set('codex_oauth_state', '', { path: '/', maxAge: 0 })
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

  if (error) return redirectWithCookieClear(`${settingsUrl}?oauth_error=${encodeURIComponent(errorDescription ?? error)}`, state)
  if (!code || !state) return redirectWithCookieClear(`${settingsUrl}?oauth_error=missing_params`, state)

  // Prefer cookie-based state (stable across hot reload / process restarts), fallback to in-memory map.
  let codeVerifier: string | null = null
  const cookieName = `codex_oauth_${state}`
  const verifierCookie = req.cookies.get(cookieName)?.value
  if (verifierCookie) {
    codeVerifier = verifierCookie
  }
  if (!codeVerifier) {
    codeVerifier = consumeOAuthState(state)
  }
  if (!codeVerifier) return redirectWithCookieClear(`${settingsUrl}?oauth_error=invalid_state`, state)

  const config = await readConfig()
  const targetProfileId = state ? req.cookies.get(`codex_oauth_profile_${state}`)?.value : undefined
  const codexProfile = targetProfileId
    ? config.profiles.find((p) => p.id === targetProfileId && p.provider === 'codex')
    : config.profiles.find((p) => p.provider === 'codex')
  const clientId = resolveCodexClientId({ codexClientId: codexProfile?.codexClientId })
  const clientSecret = resolveCodexClientSecret({ codexClientSecret: codexProfile?.codexClientSecret })
  const redirectUri = 'http://localhost:1455/auth/callback'

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    })
    if (clientSecret) params.set('client_secret', clientSecret)

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })

    if (!tokenRes.ok) {
      const body = await tokenRes.text()
      return redirectWithCookieClear(`${settingsUrl}?oauth_error=${encodeURIComponent(`token_exchange_failed:${tokenRes.status}:${body.slice(0, 120)}`)}`, state)
    }

    const tokens = (await tokenRes.json()) as { refresh_token?: string }
    if (tokens.refresh_token) {
      const idx = targetProfileId
        ? config.profiles.findIndex((p) => p.id === targetProfileId && p.provider === 'codex')
        : config.profiles.findIndex((p) => p.provider === 'codex')
      if (idx >= 0) {
        config.profiles[idx] = {
          ...config.profiles[idx],
          codexRefreshToken: tokens.refresh_token,
          codexClientId: clientId,
          codexClientSecret: clientSecret,
        }
      } else {
        config.profiles.push({
          id: targetProfileId || 'codex:oauth',
          provider: 'codex',
          displayName: 'Codex OAuth',
          allowedModels: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'],
          systemPrompts: [],
          enabled: true,
          codexRefreshToken: tokens.refresh_token,
          codexClientId: clientId,
          codexClientSecret: clientSecret,
        })
      }
      await writeConfig(config)
    }

    return redirectWithCookieClear(`${settingsUrl}?connected=codex`, state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    return redirectWithCookieClear(`${settingsUrl}?oauth_error=${encodeURIComponent(msg)}`, state)
  }
}
