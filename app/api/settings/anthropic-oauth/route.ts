import { readConfig, writeConfig } from '@/lib/config/store'
import { refreshAnthropicToken, resolveAnthropicOAuthRefreshToken } from '@/lib/ai/anthropic-auth'

function getOrCreateAnthropicProfile(config: Awaited<ReturnType<typeof readConfig>>, profileId?: string) {
  let profile = profileId
    ? config.profiles.find((p) => p.provider === 'anthropic-oauth' && p.id === profileId)
    : config.profiles.find((p) => p.provider === 'anthropic-oauth')

  if (!profile) {
    profile = {
      id: 'anthropic-oauth:oauth',
      provider: 'anthropic-oauth',
      displayName: 'Anthropic OAuth',
      enabled: true,
      extraHeaders: {
        'anthropic-beta': 'oauth-2025-04-20',
      },
      allowedModels: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
      systemPrompts: [],
    }
    config.profiles.push(profile)
  }

  return profile
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; profileId?: string }
  const config = await readConfig()
  const profile = getOrCreateAnthropicProfile(config, body.profileId)

  if (body.action === 'status') {
    const hasRefreshToken = !!resolveAnthropicOAuthRefreshToken({
      id: profile.id,
      anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
    })
    const hasAccessToken = !!(profile.claudeAuthToken && profile.claudeAuthToken !== '***')
    return Response.json({
      hasRefreshToken,
      hasAccessToken,
      connected: hasRefreshToken || hasAccessToken,
    })
  }

  if (body.action === 'refresh') {
    try {
      const token = await refreshAnthropicToken({
        id: profile.id,
        anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
      })
      const idx = config.profiles.findIndex((p) => p.id === profile.id && p.provider === 'anthropic-oauth')
      if (idx >= 0) {
        config.profiles[idx] = {
          ...config.profiles[idx],
          claudeAuthToken: token,
        }
        await writeConfig(config)
      }
      return Response.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (profile.claudeAuthToken && profile.claudeAuthToken !== '***') {
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
    profile.anthropicOAuthRefreshToken = undefined
    profile.claudeAuthToken = undefined
    await writeConfig(config)
    return Response.json({ ok: true })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
