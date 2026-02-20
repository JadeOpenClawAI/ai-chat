import { readConfig, writeConfig } from '@/lib/config/store'
import { DEFAULT_CODEX_CLIENT_ID } from '@/lib/ai/codex-auth'

function getOrCreateCodexProfile(config: Awaited<ReturnType<typeof readConfig>>, profileId?: string) {
  let profile = profileId
    ? config.profiles.find((p) => p.provider === 'codex' && p.id === profileId)
    : config.profiles.find((p) => p.provider === 'codex')
  if (!profile) {
    profile = {
      id: 'codex:default',
      provider: 'codex',
      displayName: 'Codex Default',
      enabled: true,
      allowedModels: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'],
      systemPrompts: [],
    }
    config.profiles.push(profile)
  }
  return profile
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; profileId?: string; clientId?: string; clientSecret?: string }
  const config = await readConfig()
  const profile = getOrCreateCodexProfile(config, body.profileId)

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
      return Response.json({ ok: true })
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
