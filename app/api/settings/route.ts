import {
  getProfileById,
  mergeProfileSecrets,
  readConfig,
  sanitizeConfig,
  validateProfile,
  writeConfig,
  type ProfileConfig,
  type RoutingPolicy,
} from '@/lib/config/store'
import { getModelOptions } from '@/lib/ai/providers'

interface SettingsRequest {
  action?: 'profile-create' | 'profile-update' | 'profile-delete' | 'routing-update'
  profile?: ProfileConfig
  profileId?: string
  routing?: RoutingPolicy
}

export async function GET() {
  const config = await readConfig()
  return Response.json({
    config: sanitizeConfig(config),
    models: getModelOptions(),
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as SettingsRequest
  const config = await readConfig()

  if (!body.action) {
    return Response.json({ ok: true, config: sanitizeConfig(config), models: getModelOptions() })
  }

  if (body.action === 'profile-create') {
    if (!body.profile) return Response.json({ ok: false, error: 'Missing profile' }, { status: 400 })
    validateProfile(body.profile)
    if (getProfileById(config, body.profile.id)) {
      return Response.json({ ok: false, error: 'Profile already exists' }, { status: 400 })
    }
    config.profiles.push(body.profile)
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'profile-update') {
    if (!body.profile) return Response.json({ ok: false, error: 'Missing profile' }, { status: 400 })
    validateProfile(body.profile)
    const idx = config.profiles.findIndex((p) => p.id === body.profile!.id)
    if (idx === -1) return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 })
    const previous = config.profiles[idx]
    if (previous?.requiredFirstSystemPrompt && body.profile.requiredFirstSystemPrompt !== previous.requiredFirstSystemPrompt) {
      return Response.json({ ok: false, error: 'requiredFirstSystemPrompt is immutable once set' }, { status: 400 })
    }
    config.profiles[idx] = mergeProfileSecrets(previous, body.profile)
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'profile-delete') {
    if (!body.profileId) return Response.json({ ok: false, error: 'Missing profileId' }, { status: 400 })
    config.profiles = config.profiles.filter((p) => p.id !== body.profileId)
    if (config.routing.primary.profileId === body.profileId && config.profiles[0]) {
      config.routing.primary = {
        profileId: config.profiles[0].id,
        modelId: config.profiles[0].allowedModels[0] ?? 'claude-sonnet-4-5',
      }
    }
    config.routing.fallbacks = config.routing.fallbacks.filter((f) => f.profileId !== body.profileId)
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'routing-update') {
    if (!body.routing) return Response.json({ ok: false, error: 'Missing routing' }, { status: 400 })
    config.routing = body.routing
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
