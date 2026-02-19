import { readConfig, writeConfig } from '@/lib/config/store'
import { DEFAULT_CODEX_CLIENT_ID } from '@/lib/ai/codex-auth'

function getOrCreateCodexProfile(config: Awaited<ReturnType<typeof readConfig>>) {
  let profile = config.profiles.find((p) => p.provider === 'codex')
  if (!profile) {
    profile = {
      id: 'codex:default',
      provider: 'codex',
      displayName: 'Codex Default',
      enabled: true,
      allowedModels: ['codex-mini-latest', 'gpt-5.3-codex', 'o3', 'o4-mini'],
      systemPrompts: [],
    }
    config.profiles.push(profile)
  }
  return profile
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; clientId?: string; clientSecret?: string }
  const config = await readConfig()
  const profile = getOrCreateCodexProfile(config)

  if (body.action === 'status') {
    return Response.json({
      hasClientId: !!(profile.codexClientId ?? process.env.OPENAI_CODEX_CLIENT_ID ?? DEFAULT_CODEX_CLIENT_ID),
      hasClientSecret: !!(profile.codexClientSecret ?? process.env.OPENAI_CODEX_CLIENT_SECRET),
      hasRefreshToken: !!(profile.codexRefreshToken ?? process.env.OPENAI_CODEX_REFRESH_TOKEN),
      connected: !!(profile.codexRefreshToken ?? process.env.OPENAI_CODEX_REFRESH_TOKEN),
    })
  }

  if (body.action === 'refresh') {
    try {
      const { refreshCodexToken } = await import('@/lib/ai/codex-auth')
      const token = await refreshCodexToken(profile)
      return Response.json({ ok: true, tokenPreview: token.slice(0, 16) + '...' })
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (body.action === 'save') {
    profile.codexClientId = body.clientId
    profile.codexClientSecret = body.clientSecret
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  if (body.action === 'revoke') {
    profile.codexClientId = undefined
    profile.codexClientSecret = undefined
    profile.codexRefreshToken = undefined
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
