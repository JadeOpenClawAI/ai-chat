import { type NextRequest } from 'next/server'
import { readConfig, sanitizeConfig, writeConfig, type RoutingPolicy } from '@/lib/config/store'

export async function GET() {
  const config = await readConfig()
  return Response.json({ routing: sanitizeConfig(config).routing })
}

export async function POST(req: NextRequest) {
  const routing = (await req.json()) as RoutingPolicy
  const config = await readConfig()
  config.routing = {
    primary: routing.primary,
    fallbacks: routing.fallbacks ?? [],
    maxAttempts: Math.max(1, routing.maxAttempts ?? 3),
  }
  await writeConfig(config)
  return Response.json({ ok: true, routing: sanitizeConfig(config).routing })
}
