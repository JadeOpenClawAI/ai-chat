import {
  normalizeConfig,
  getProfileById,
  mergeProfileSecrets,
  readConfig,
  sanitizeConfig,
  validateProfile,
  writeConfig,
  type ProfileConfig,
  type ContextManagementPolicy,
  type ToolCompactionPolicy,
  type RoutingPolicy,
} from '@/lib/config/store'
import { getModelOptions } from '@/lib/ai/providers'

interface SettingsRequest {
  action?: 'profile-create' | 'profile-update' | 'profile-delete' | 'routing-update' | 'context-management-update' | 'tool-compaction-update'
  profile?: ProfileConfig
  profileId?: string
  originalProfileId?: string
  routing?: RoutingPolicy
  contextManagement?: Partial<ContextManagementPolicy>
  toolCompaction?: Partial<ToolCompactionPolicy>
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

    const lookupId = body.originalProfileId ?? body.profile.id
    const idx = config.profiles.findIndex((p) => p.id === lookupId)
    if (idx === -1) return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 })

    // Prevent id collision when renaming.
    if (body.profile.id !== lookupId && config.profiles.some((p) => p.id === body.profile!.id)) {
      return Response.json({ ok: false, error: 'Profile ID already exists' }, { status: 400 })
    }

    const previous = config.profiles[idx]
    if (previous?.requiredFirstSystemPrompt && body.profile.requiredFirstSystemPrompt !== previous.requiredFirstSystemPrompt) {
      return Response.json({ ok: false, error: 'requiredFirstSystemPrompt is immutable once set' }, { status: 400 })
    }
    config.profiles[idx] = mergeProfileSecrets(previous, body.profile)

    // Rewrite routing + conversation refs if profile id changed.
    if (body.profile.id !== lookupId) {
      config.routing.modelPriority = config.routing.modelPriority.map((t) =>
        t.profileId === lookupId ? { ...t, profileId: body.profile!.id } : t,
      )
      for (const key of Object.keys(config.conversations)) {
        const state = config.conversations[key]
        if (state?.activeProfileId === lookupId) {
          config.conversations[key] = { ...state, activeProfileId: body.profile.id }
        }
      }
    }

    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'profile-delete') {
    if (!body.profileId) return Response.json({ ok: false, error: 'Missing profileId' }, { status: 400 })
    config.profiles = config.profiles.filter((p) => p.id !== body.profileId)
    // Remove deleted profile from priority list
    config.routing.modelPriority = config.routing.modelPriority.filter((t) => t.profileId !== body.profileId)
    // Ensure at least one entry
    if (config.routing.modelPriority.length === 0 && config.profiles[0]) {
      config.routing.modelPriority = [{
        profileId: config.profiles[0].id,
        modelId: config.profiles[0].allowedModels[0] ?? 'claude-sonnet-4-5',
      }]
    }
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'routing-update') {
    if (!body.routing) return Response.json({ ok: false, error: 'Missing routing' }, { status: 400 })
    config.routing = body.routing
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'context-management-update') {
    if (!body.contextManagement) {
      return Response.json({ ok: false, error: 'Missing contextManagement' }, { status: 400 })
    }
    const normalized = normalizeConfig({
      ...config,
      contextManagement: {
        ...config.contextManagement,
        ...body.contextManagement,
      },
    })
    config.contextManagement = normalized.contextManagement
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  if (body.action === 'tool-compaction-update') {
    if (!body.toolCompaction) {
      return Response.json({ ok: false, error: 'Missing toolCompaction' }, { status: 400 })
    }
    const normalized = normalizeConfig({
      ...config,
      toolCompaction: {
        ...config.toolCompaction,
        ...body.toolCompaction,
      },
    })
    config.toolCompaction = normalized.toolCompaction
    await writeConfig(config)
    return Response.json({ ok: true, config: sanitizeConfig(config) })
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}
