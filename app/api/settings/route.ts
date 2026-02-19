// ============================================================
// Settings API Route
// GET  — return sanitized config (no secrets in response)
// POST — save config fields (merged with existing)
// ============================================================

import { readConfig, writeConfig, sanitizeConfig } from '@/lib/config/store'
import type { AppConfig, ProviderConfig } from '@/lib/config/store'
import { type NextRequest } from 'next/server'

export async function GET() {
  const config = await readConfig()
  return Response.json(sanitizeConfig(config))
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<AppConfig> & {
    providers?: Record<string, Record<string, string | Record<string, string> | undefined>>
  }
  const existing = await readConfig()

  // Deep merge providers
  const merged: AppConfig = {
    ...existing,
    providers: {
      ...existing.providers,
    },
    updatedAt: new Date().toISOString(),
  }

  // Merge each provider config sent in the body
  for (const [provider, cfg] of Object.entries(body.providers ?? {})) {
    const key = provider as keyof AppConfig['providers']
    const existingProvider: ProviderConfig = existing.providers[key] ?? {}
    const incoming = cfg as Record<string, string | Record<string, string> | undefined>

    // Start with existing, then selectively overwrite
    const target: ProviderConfig = { ...existingProvider }

    // Only overwrite secrets if the incoming value is not '***' (masked placeholder)
    const secretKeys = ['apiKey', 'codexClientId', 'codexClientSecret', 'codexRefreshToken'] as const
    for (const secretKey of secretKeys) {
      const val = incoming[secretKey]
      if (typeof val === 'string' && val && val !== '***') {
        target[secretKey] = val
      }
    }

    // Always overwrite non-secret string fields
    const nonSecretStringKeys = ['baseUrl', 'systemPrompt'] as const
    for (const strKey of nonSecretStringKeys) {
      const val = incoming[strKey]
      if (val !== undefined) {
        target[strKey] = typeof val === 'string' ? val : undefined
      }
    }

    // Extra headers is a nested object
    if (incoming.extraHeaders !== undefined) {
      target.extraHeaders = typeof incoming.extraHeaders === 'object' && !Array.isArray(incoming.extraHeaders)
        ? (incoming.extraHeaders as Record<string, string>)
        : undefined
    }

    merged.providers[key] = target
  }

  if (typeof body.defaultProvider === 'string') merged.defaultProvider = body.defaultProvider
  if (typeof body.defaultModel === 'string') merged.defaultModel = body.defaultModel

  await writeConfig(merged)
  return Response.json({ ok: true, config: sanitizeConfig(merged) })
}
