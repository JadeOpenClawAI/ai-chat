import { NextRequest } from 'next/server'
import { consumeOAuthState } from '@/lib/ai/oauth-state'
import { readConfig, writeConfig } from '@/lib/config/store'
import { DEFAULT_CODEX_CLIENT_ID } from '@/lib/ai/codex-auth'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const host = req.headers.get('host') ?? 'localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const settingsUrl = `${protocol}://${host}/settings`

  if (error) return Response.redirect(`${settingsUrl}?oauth_error=${encodeURIComponent(errorDescription ?? error)}`)
  if (!code || !state) return Response.redirect(`${settingsUrl}?oauth_error=missing_params`)

  const codeVerifier = consumeOAuthState(state)
  if (!codeVerifier) return Response.redirect(`${settingsUrl}?oauth_error=invalid_state`)

  const config = await readConfig()
  const codexProfile = config.profiles.find((p) => p.provider === 'codex')
  const clientId = codexProfile?.codexClientId ?? process.env.OPENAI_CODEX_CLIENT_ID ?? DEFAULT_CODEX_CLIENT_ID
  const clientSecret = codexProfile?.codexClientSecret ?? process.env.OPENAI_CODEX_CLIENT_SECRET
  const redirectUri = `${protocol}://${host}/auth/callback`

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    })

    if (!tokenRes.ok) {
      const body = await tokenRes.text()
      return Response.redirect(`${settingsUrl}?oauth_error=${encodeURIComponent(`token_exchange_failed:${tokenRes.status}:${body.slice(0, 120)}`)}`)
    }

    const tokens = (await tokenRes.json()) as { refresh_token?: string }
    if (tokens.refresh_token) {
      const idx = config.profiles.findIndex((p) => p.provider === 'codex')
      if (idx >= 0) {
        config.profiles[idx] = { ...config.profiles[idx], codexRefreshToken: tokens.refresh_token }
      } else {
        config.profiles.push({
          id: 'codex:oauth',
          provider: 'codex',
          displayName: 'Codex OAuth',
          allowedModels: ['codex-mini-latest', 'o3', 'o4-mini'],
          systemPrompts: [],
          enabled: true,
          codexRefreshToken: tokens.refresh_token,
          codexClientId: clientId,
          codexClientSecret: clientSecret,
        })
      }
      await writeConfig(config)
    }

    return Response.redirect(`${settingsUrl}?connected=codex`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    return Response.redirect(`${settingsUrl}?oauth_error=${encodeURIComponent(msg)}`)
  }
}
