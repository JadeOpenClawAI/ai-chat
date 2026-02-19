// ============================================================
// Codex OAuth Authorize Route
// GET /api/auth/codex/authorize
// Builds PKCE challenge + redirects to OpenAI's authorization page
// ============================================================

import { NextRequest } from 'next/server'
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/ai/pkce'
import { saveOAuthState } from '@/lib/ai/oauth-state'
import { readConfig } from '@/lib/config/store'
import { DEFAULT_CODEX_CLIENT_ID } from '@/lib/ai/codex-auth'

const DEFAULT_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const DEFAULT_SCOPES = 'openid profile email offline_access'

export async function GET(req: NextRequest) {
  const config = await readConfig()
  const codexCfg = config.providers?.codex ?? {}

  // Client ID fallback order: saved config -> env -> official Codex CLI public client
  const clientId = codexCfg.codexClientId ?? process.env.OPENAI_CODEX_CLIENT_ID ?? DEFAULT_CODEX_CLIENT_ID

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  saveOAuthState(state, codeVerifier)

  // Build the redirect_uri pointing back to our callback
  const host = req.headers.get('host') ?? 'localhost:3000'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  const redirectUri = `${protocol}://${host}/auth/callback`

  const authUrl = new URL(DEFAULT_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', DEFAULT_SCOPES)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  return Response.redirect(authUrl.toString())
}
