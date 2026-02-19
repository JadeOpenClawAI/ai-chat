// PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0
// Server-side only — uses Node.js crypto

import crypto from 'crypto'

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}
