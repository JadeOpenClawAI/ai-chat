import { MODEL_OPTIONS } from '@/lib/types'
import { readConfig, sanitizeConfig } from '@/lib/config/store'

export async function GET() {
  const config = await readConfig()
  const safe = sanitizeConfig(config)
  return Response.json({
    profiles: safe.profiles,
    models: MODEL_OPTIONS,
  })
}
