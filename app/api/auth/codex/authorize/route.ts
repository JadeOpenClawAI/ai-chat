// ============================================================
// Codex OAuth Authorize Route
// GET /api/auth/codex/authorize
// Builds PKCE challenge + redirects to OpenAI's authorization page
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/ai/pkce'
import { saveOAuthState } from '@/lib/ai/oauth-state'
import { readConfig } from '@/lib/config/store'
import { resolveCodexClientId } from '@/lib/ai/codex-auth'

const DEFAULT_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const DEFAULT_SCOPES = 'openid profile email offline_access'

export async function GET(_req: NextRequest) {
  const config = await readConfig()
  const codexCfg = config.profiles.find((p) => p.provider === 'codex')

  // Client ID fallback order: saved config -> env -> official Codex CLI public client
  // Empty / masked values are ignored.
  const clientId = resolveCodexClientId({ codexClientId: codexCfg?.codexClientId })

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  saveOAuthState(state, codeVerifier)

  // Match Codex CLI redirect URI exactly for OAuth compatibility
  const redirectUri = 'http://localhost:1455/auth/callback'

  const authUrl = new URL(DEFAULT_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', DEFAULT_SCOPES)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  // Match Codex CLI flow shape for better compatibility
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', 'pi')

  const response = NextResponse.redirect(authUrl.toString())
  const cookiePayload = Buffer.from(JSON.stringify({ state, codeVerifier }), 'utf8').toString('base64url')
  response.cookies.set('codex_oauth_state', cookiePayload, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 10 * 60,
  })

  return response
}
