// ============================================================
// Codex OAuth Route
// POST action=refresh — refresh existing token
// POST action=save   — save Codex OAuth credentials
// POST action=revoke — clear stored Codex credentials
// ============================================================

import { readConfig, writeConfig } from '@/lib/config/store'

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action: string
    clientId?: string
    clientSecret?: string
    refreshToken?: string
  }
  const { action } = body

  if (action === 'refresh') {
    const config = await readConfig()
    const codexCfg = config.providers.codex ?? {}
    try {
      const { refreshCodexToken } = await import('@/lib/ai/codex-auth')
      const token = await refreshCodexToken({
        codexClientId: codexCfg.codexClientId,
        codexClientSecret: codexCfg.codexClientSecret,
        codexRefreshToken: codexCfg.codexRefreshToken,
      })
      return Response.json({ ok: true, tokenPreview: token.slice(0, 16) + '...' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return Response.json({ ok: false, error: message }, { status: 200 })
    }
  }

  if (action === 'save') {
    const { clientId, clientSecret, refreshToken } = body
    const config = await readConfig()
    config.providers.codex = {
      ...(config.providers.codex ?? {}),
      codexClientId: clientId,
      codexClientSecret: clientSecret,
      codexRefreshToken: refreshToken,
    }
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  if (action === 'revoke') {
    const config = await readConfig()
    config.providers.codex = {
      ...(config.providers.codex ?? {}),
      codexClientId: undefined,
      codexClientSecret: undefined,
      codexRefreshToken: undefined,
    }
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
