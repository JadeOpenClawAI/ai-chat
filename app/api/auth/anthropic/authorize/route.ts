import { NextRequest, NextResponse } from 'next/server'
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/ai/pkce'
import { saveOAuthState } from '@/lib/ai/oauth-state'
import {
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_SCOPES,
  resolveAnthropicOAuthClientId,
  resolveAnthropicOAuthRedirectUri,
} from '@/lib/ai/anthropic-auth'

export async function GET(req: NextRequest) {
  const profileIdRaw = req.nextUrl.searchParams.get('profileId')?.trim()
  const profileId = profileIdRaw?.startsWith('anthropic-oauth:') ? profileIdRaw : undefined
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  saveOAuthState(state, codeVerifier)

  const redirectUri = resolveAnthropicOAuthRedirectUri()
  const authUrl = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL)
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', resolveAnthropicOAuthClientId())
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPES.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  const response = NextResponse.redirect(authUrl.toString())
  response.cookies.set(`anthropic_oauth_${state}`, codeVerifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // TODO: dynamically switch to true if we're on https
    path: '/',
    maxAge: 10 * 60,
  })
  if (profileId) {
    response.cookies.set(`anthropic_oauth_profile_${state}`, profileId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // TODO: dynamically switch to true if we're on https
      path: '/',
      maxAge: 10 * 60,
    })
  }

  return response
}
