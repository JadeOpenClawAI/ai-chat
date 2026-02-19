import fs from 'fs/promises'
import path from 'path'
import type { LLMProvider } from '@/lib/types'

const CONFIG_PATH = path.join(process.cwd(), 'config', 'providers.json')
const SECRET_MASK = '***'
export const PROFILE_ID_REGEX = /^(anthropic|openai|codex):[a-zA-Z0-9._-]+$/

export interface ProfileConfig {
  id: string
  provider: LLMProvider
  displayName: string
  enabled: boolean
  apiKey?: string
  codexClientId?: string
  codexClientSecret?: string
  codexRefreshToken?: string
  baseUrl?: string
  extraHeaders?: Record<string, string>
  allowedModels: string[]
  requiredFirstSystemPrompt?: string
  systemPrompts: string[]
}

export interface RouteTarget {
  profileId: string
  modelId: string
}

/** @deprecated kept only for migration compat */
export interface LegacyRoutingPolicy {
  primary: RouteTarget
  fallbacks: RouteTarget[]
  maxAttempts: number
}

export interface RoutingPolicy {
  /** Ordered preference list — first entry is primary, rest are fallbacks */
  modelPriority: RouteTarget[]
  maxAttempts: number
}

export interface ConversationRouteState {
  activeProfileId: string
  activeModelId: string
}

export interface AppConfig {
  profiles: ProfileConfig[]
  routing: RoutingPolicy
  conversations: Record<string, ConversationRouteState>
  updatedAt?: string
}

interface LegacyProviderConfig {
  apiKey?: string
  baseUrl?: string
  extraHeaders?: Record<string, string>
  systemPrompt?: string
  codexClientId?: string
  codexClientSecret?: string
  codexRefreshToken?: string
}

interface LegacyConfig {
  providers?: Partial<Record<LLMProvider, LegacyProviderConfig>>
  defaultProvider?: string
  defaultModel?: string
  updatedAt?: string
}

function defaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic') return 'claude-sonnet-4-5'
  if (provider === 'openai') return 'gpt-4o'
  return 'gpt-5.3-codex'
}

function defaultAllowedModels(provider: LLMProvider): string[] {
  if (provider === 'anthropic') return ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-3-5']
  if (provider === 'openai') return ['gpt-4o', 'gpt-4o-mini', 'o3-mini']
  return ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini']
}

function defaultConfig(): AppConfig {
  return {
    profiles: [
      {
        id: 'anthropic:default',
        provider: 'anthropic',
        displayName: 'Anthropic Default',
        enabled: true,
        allowedModels: defaultAllowedModels('anthropic'),
        systemPrompts: [],
      },
    ],
    routing: {
      modelPriority: [{ profileId: 'anthropic:default', modelId: 'claude-sonnet-4-5' }],
      maxAttempts: 3,
    },
    conversations: {},
  }
}

function migrateLegacy(raw: unknown): AppConfig {
  const legacy = (raw ?? {}) as LegacyConfig
  const profiles: ProfileConfig[] = []

  for (const provider of ['anthropic', 'openai', 'codex'] as const) {
    const cfg = legacy.providers?.[provider]
    if (!cfg) continue
    profiles.push({
      id: `${provider}:default`,
      provider,
      displayName: `${provider.toUpperCase()} Default`,
      enabled: true,
      apiKey: cfg.apiKey,
      codexClientId: cfg.codexClientId,
      codexClientSecret: cfg.codexClientSecret,
      codexRefreshToken: cfg.codexRefreshToken,
      baseUrl: cfg.baseUrl,
      extraHeaders: cfg.extraHeaders,
      allowedModels: defaultAllowedModels(provider),
      requiredFirstSystemPrompt: undefined,
      systemPrompts: cfg.systemPrompt ? [cfg.systemPrompt] : [],
    })
  }

  const baseProfiles = profiles.length > 0 ? profiles : defaultConfig().profiles
  const defaultProvider = (legacy.defaultProvider as LLMProvider | undefined) ?? baseProfiles[0].provider
  const primaryProfile = baseProfiles.find((p) => p.provider === defaultProvider) ?? baseProfiles[0]

  return normalizeConfig({
    profiles: baseProfiles,
    routing: {
      modelPriority: [
        {
          profileId: primaryProfile.id,
          modelId: legacy.defaultModel ?? defaultModelForProvider(primaryProfile.provider),
        },
      ],
      maxAttempts: 3,
    },
    conversations: {},
    updatedAt: legacy.updatedAt,
  })
}

export function validateProfileId(id: string): boolean {
  return PROFILE_ID_REGEX.test(id)
}

export function validateProfile(profile: ProfileConfig): void {
  if (!validateProfileId(profile.id)) {
    throw new Error('Profile id must match ^(anthropic|openai|codex):[a-zA-Z0-9._-]+$')
  }
  if (!profile.id.startsWith(`${profile.provider}:`)) {
    throw new Error('Profile id prefix must match provider')
  }
  if (profile.requiredFirstSystemPrompt) {
    if (profile.systemPrompts[0] !== profile.requiredFirstSystemPrompt) {
      throw new Error('requiredFirstSystemPrompt must be first in systemPrompts')
    }
  }
}

export function validateRequiredPrompt(profile: ProfileConfig): void {
  if (!profile.requiredFirstSystemPrompt) return
  if (profile.systemPrompts[0] !== profile.requiredFirstSystemPrompt) {
    throw new Error('requiredFirstSystemPrompt cannot be reordered or removed from first position')
  }
}

export function composeSystemPrompt(profile: ProfileConfig, requestOverride?: string): string {
  const parts: string[] = []
  if (profile.requiredFirstSystemPrompt) parts.push(profile.requiredFirstSystemPrompt)
  for (const prompt of profile.systemPrompts) {
    if (!prompt.trim()) continue
    if (profile.requiredFirstSystemPrompt && prompt === profile.requiredFirstSystemPrompt) continue
    parts.push(prompt)
  }
  if (requestOverride?.trim()) parts.push(requestOverride)
  return parts.join('\n\n').trim()
}

export function normalizeConfig(config: AppConfig): AppConfig {
  const validProfiles = config.profiles.filter((profile) => {
    try {
      validateProfile({
        ...profile,
        enabled: profile.enabled ?? true,
        allowedModels: profile.allowedModels ?? defaultAllowedModels(profile.provider),
        systemPrompts: profile.systemPrompts ?? [],
      })
      return true
    } catch {
      return false
    }
  })

  const profiles = validProfiles.length > 0 ? validProfiles : defaultConfig().profiles
  // Migrate old primary/fallbacks format to modelPriority
  const rawRouting = config.routing as RoutingPolicy & Partial<LegacyRoutingPolicy>
  let modelPriority: RouteTarget[] = rawRouting.modelPriority ?? []
  if (modelPriority.length === 0 && rawRouting.primary) {
    modelPriority = [rawRouting.primary, ...(rawRouting.fallbacks ?? [])]
  }
  // Filter to only valid profiles
  modelPriority = modelPriority.filter((t) => profiles.some((p) => p.id === t.profileId))
  // Ensure at least one entry
  if (modelPriority.length === 0) {
    modelPriority = [{ profileId: profiles[0].id, modelId: defaultModelForProvider(profiles[0].provider) }]
  }

  return {
    profiles: profiles.map((p) => ({
      ...p,
      enabled: p.enabled ?? true,
      allowedModels: p.allowedModels ?? defaultAllowedModels(p.provider),
      systemPrompts: p.systemPrompts ?? [],
    })),
    routing: {
      modelPriority,
      maxAttempts: Math.max(1, rawRouting.maxAttempts ?? 3),
    },
    conversations: config.conversations ?? {},
    updatedAt: config.updatedAt,
  }
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && 'profiles' in (raw as Record<string, unknown>)) {
      return normalizeConfig(raw as AppConfig)
    }
    const migrated = migrateLegacy(raw)
    await writeConfig(migrated)
    return migrated
  } catch {
    return defaultConfig()
  }
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() })
  await fs.writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8')
}

function sanitizeProfile(profile: ProfileConfig): ProfileConfig {
  return {
    ...profile,
    apiKey: profile.apiKey ? SECRET_MASK : undefined,
    codexClientId: profile.codexClientId ? SECRET_MASK : undefined,
    codexClientSecret: profile.codexClientSecret ? SECRET_MASK : undefined,
    codexRefreshToken: profile.codexRefreshToken ? SECRET_MASK : undefined,
  }
}

export function sanitizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    profiles: config.profiles.map(sanitizeProfile),
  }
}

export function mergeProfileSecrets(existing: ProfileConfig | undefined, incoming: ProfileConfig): ProfileConfig {
  const merged = { ...incoming }
  const secretKeys: Array<keyof ProfileConfig> = ['apiKey', 'codexClientId', 'codexClientSecret', 'codexRefreshToken']
  for (const key of secretKeys) {
    if (incoming[key] === SECRET_MASK && existing?.[key]) {
      ;(merged as Record<string, unknown>)[key] = existing[key]
    }
  }
  return merged
}

export function getProfileById(config: AppConfig, profileId: string): ProfileConfig | undefined {
  return config.profiles.find((p) => p.id === profileId)
}

export function getLegacyProviderView(config: AppConfig): Partial<Record<LLMProvider, ProfileConfig>> {
  return {
    anthropic: config.profiles.find((p) => p.provider === 'anthropic'),
    openai: config.profiles.find((p) => p.provider === 'openai'),
    codex: config.profiles.find((p) => p.provider === 'codex'),
  }
}
