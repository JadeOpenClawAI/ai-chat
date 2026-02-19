// Temporary in-memory state store for OAuth flows
// Maps state → { codeVerifier, createdAt }
// Entries expire after 10 minutes
//
// NOTE: This in-memory store works for single-instance development.
// In production with multiple server instances, use a shared store like Redis.

interface OAuthState {
  codeVerifier: string
  createdAt: number
}

const stateStore = new Map<string, OAuthState>()

const TTL_MS = 10 * 60 * 1000 // 10 minutes

export function saveOAuthState(state: string, codeVerifier: string): void {
  // Clean up expired entries first
  const now = Date.now()
  for (const [key, value] of stateStore.entries()) {
    if (now - value.createdAt > TTL_MS) {
      stateStore.delete(key)
    }
  }
  stateStore.set(state, { codeVerifier, createdAt: now })
}

export function consumeOAuthState(state: string): string | null {
  const entry = stateStore.get(state)
  if (!entry) return null
  stateStore.delete(state) // One-time use
  if (Date.now() - entry.createdAt > TTL_MS) return null // Expired
  return entry.codeVerifier
}
