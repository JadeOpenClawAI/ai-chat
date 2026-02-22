import { readConfig, writeConfig } from '@/lib/config/store'
import { refreshGoogleToken, type GoogleProviderType } from '@/lib/ai/google-auth'

function getOrCreateGoogleProfile(
  config: Awaited<ReturnType<typeof readConfig>>,
  providerType: GoogleProviderType,
  profileId?: string,
) {
  let profile = profileId
    ? config.profiles.find((p) => p.provider === providerType && p.id === profileId)
    : config.profiles.find((p) => p.provider === providerType)

  if (!profile) {
    const defaultAllowedModels = providerType === 'google-antigravity'
      ? ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash']
      : ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
    const label = providerType === 'google-antigravity' ? 'Antigravity' : 'Gemini CLI'
    profile = {
      id: `${providerType}:oauth`,
      provider: providerType,
      displayName: `${label} OAuth`,
      enabled: true,
      allowedModels: defaultAllowedModels,
      systemPrompts: [],
    }
    config.profiles.push(profile)
  }

  return profile
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; profileId?: string; providerType?: string }
  const config = await readConfig()

  // Determine provider type from profileId or explicit param
  let providerType: GoogleProviderType = (body.providerType as GoogleProviderType) ?? 'google-gemini-cli'
  if (body.profileId) {
    const existing = config.profiles.find((p) => p.id === body.profileId)
    if (existing && (existing.provider === 'google-antigravity' || existing.provider === 'google-gemini-cli')) {
      providerType = existing.provider
    }
  }

  const profile = getOrCreateGoogleProfile(config, providerType, body.profileId)

  if (body.action === 'status') {
    const hasRefreshToken = !!(profile.googleOAuthRefreshToken && profile.googleOAuthRefreshToken !== '***')
    const hasAccessToken = !!(profile.googleOAuthAccessToken && profile.googleOAuthAccessToken !== '***')
    return Response.json({
      hasRefreshToken,
      hasAccessToken,
      connected: hasRefreshToken || hasAccessToken,
      projectId: profile.googleOAuthProjectId,
      email: profile.googleOAuthEmail,
    })
  }

  if (body.action === 'refresh') {
    try {
      const token = await refreshGoogleToken({
        id: profile.id,
        googleOAuthRefreshToken: profile.googleOAuthRefreshToken,
        googleOAuthAccessToken: profile.googleOAuthAccessToken,
        googleOAuthProjectId: profile.googleOAuthProjectId,
        googleOAuthExpiresAt: profile.googleOAuthExpiresAt,
        provider: providerType,
      })
      const idx = config.profiles.findIndex((p) => p.id === profile.id && p.provider === providerType)
      if (idx >= 0) {
        config.profiles[idx] = {
          ...config.profiles[idx],
          googleOAuthAccessToken: token,
        }
        await writeConfig(config)
      }
      return Response.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (profile.googleOAuthAccessToken && profile.googleOAuthAccessToken !== '***') {
        return Response.json({
          ok: true,
          degraded: true,
          warning: 'refresh_failed_using_cached_access_token',
          error: message,
        })
      }
      return Response.json({ ok: false, error: message })
    }
  }

  if (body.action === 'revoke') {
    profile.googleOAuthRefreshToken = undefined
    profile.googleOAuthAccessToken = undefined
    profile.googleOAuthProjectId = undefined
    profile.googleOAuthEmail = undefined
    profile.googleOAuthExpiresAt = undefined
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
