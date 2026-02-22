// ============================================================
// Google OAuth Authorize Route
// GET /api/auth/google/authorize?provider=google-antigravity|google-gemini-cli
// Builds PKCE challenge + redirects to Google's authorization page
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/ai/pkce'
import { saveOAuthState } from '@/lib/ai/oauth-state'
import {
  GOOGLE_AUTH_URL,
  getGoogleClientId,
  getGoogleScopes,
  getGoogleRedirectUri,
  type GoogleProviderType,
} from '@/lib/ai/google-auth'

function shouldUseSecureCookies(req: NextRequest): boolean {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (forwardedProto) return forwardedProto === 'https'
  return req.nextUrl.protocol === 'https:'
}

export async function GET(req: NextRequest) {
  const providerType = (req.nextUrl.searchParams.get('provider') ?? 'google-gemini-cli') as GoogleProviderType
  const profileId = req.nextUrl.searchParams.get('profileId')?.trim()

  if (providerType !== 'google-antigravity' && providerType !== 'google-gemini-cli') {
    return NextResponse.json({ error: 'Invalid provider type' }, { status: 400 })
  }

  const clientId = getGoogleClientId(providerType)
  const scopes = getGoogleScopes(providerType)
  const redirectUri = getGoogleRedirectUri(providerType)

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  saveOAuthState(state, codeVerifier)

  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', scopes.join(' '))
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')

  const response = NextResponse.redirect(authUrl.toString())
  const secureCookies = shouldUseSecureCookies(req)

  response.cookies.set(`google_oauth_${state}`, codeVerifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
    maxAge: 10 * 60,
  })
  response.cookies.set(`google_oauth_provider_${state}`, providerType, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
    maxAge: 10 * 60,
  })
  if (profileId) {
    response.cookies.set(`google_oauth_profile_${state}`, profileId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      maxAge: 10 * 60,
    })
  }

  return response
}
