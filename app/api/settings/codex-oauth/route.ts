// ============================================================
// Codex OAuth Route
// POST action=refresh — refresh existing token
// POST action=save   — save Client ID + Client Secret only
//                      (refresh token comes from the OAuth flow)
// POST action=revoke — clear stored Codex credentials
// POST action=status — return which credentials are configured
// ============================================================

import { readConfig, writeConfig } from '@/lib/config/store'
import { DEFAULT_CODEX_CLIENT_ID } from '@/lib/ai/codex-auth'

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action: string
    clientId?: string
    clientSecret?: string
    refreshToken?: string
  }
  const { action } = body

  if (action === 'status') {
    const config = await readConfig()
    const codexCfg = config.providers?.codex ?? {}
    return Response.json({
      hasClientId: !!(codexCfg.codexClientId ?? process.env.OPENAI_CODEX_CLIENT_ID ?? DEFAULT_CODEX_CLIENT_ID),
      hasClientSecret: !!(codexCfg.codexClientSecret ?? process.env.OPENAI_CODEX_CLIENT_SECRET),
      hasRefreshToken: !!(codexCfg.codexRefreshToken ?? process.env.OPENAI_CODEX_REFRESH_TOKEN),
      connected: !!(codexCfg.codexRefreshToken ?? process.env.OPENAI_CODEX_REFRESH_TOKEN),
    })
  }

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
    // Save only Client ID and Client Secret — refresh token comes from OAuth flow
    const { clientId, clientSecret } = body
    const config = await readConfig()
    config.providers.codex = {
      ...(config.providers.codex ?? {}),
      codexClientId: clientId,
      codexClientSecret: clientSecret,
      // Preserve existing refresh token — do NOT overwrite from this action
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
