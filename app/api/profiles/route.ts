import { type NextRequest } from 'next/server'
import {
  mergeProfileSecrets,
  readConfig,
  sanitizeConfig,
  validateRequiredPrompt,
  writeConfig,
  type ProfileConfig,
} from '@/lib/config/store'

function isValidProfileId(id: string, provider: string): boolean {
  const [prefix, name, ...rest] = id.split(':')
  return rest.length === 0 && prefix === provider && !!name
}

export async function GET() {
  const config = await readConfig()
  return Response.json({ profiles: sanitizeConfig(config).profiles })
}

export async function POST(req: NextRequest) {
  const incoming = (await req.json()) as ProfileConfig
  if (!isValidProfileId(incoming.id, incoming.provider)) {
    return Response.json({ error: 'Invalid profile id format. Must be <provider>:<name>' }, { status: 400 })
  }

  const config = await readConfig()
  if (config.profiles.some((p) => p.id === incoming.id)) {
    return Response.json({ error: 'Profile id already exists' }, { status: 409 })
  }

  validateRequiredPrompt(incoming)
  config.profiles.push(incoming)
  await writeConfig(config)
  return Response.json({ ok: true, profile: sanitizeConfig(config).profiles.find((p) => p.id === incoming.id) })
}

export async function PUT(req: NextRequest) {
  const incoming = (await req.json()) as ProfileConfig
  if (!isValidProfileId(incoming.id, incoming.provider)) {
    return Response.json({ error: 'Invalid profile id format. Must be <provider>:<name>' }, { status: 400 })
  }

  const config = await readConfig()
  const idx = config.profiles.findIndex((p) => p.id === incoming.id)
  if (idx < 0) return Response.json({ error: 'Profile not found' }, { status: 404 })

  const merged = mergeProfileSecrets(config.profiles[idx], incoming)
  validateRequiredPrompt(merged)
  config.profiles[idx] = merged
  await writeConfig(config)
  return Response.json({ ok: true, profile: sanitizeConfig(config).profiles[idx] })
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 })

  const config = await readConfig()
  config.profiles = config.profiles.filter((p) => p.id !== id)
  if (config.routing.primary.profileId === id && config.profiles[0]) {
    config.routing.primary.profileId = config.profiles[0].id
  }
  config.routing.fallbacks = config.routing.fallbacks.filter((f) => f.profileId !== id)
  await writeConfig(config)
  return Response.json({ ok: true })
}
