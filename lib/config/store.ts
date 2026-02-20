import fs from 'fs/promises'
import path from 'path'
import type { LLMProvider } from '@/lib/types'
import type { ContextCompactionMode, ToolCompactionMode } from '@/lib/types'

const CONFIG_PATH = path.join(process.cwd(), 'config', 'providers.json')
const SECRET_MASK = '***'
export const PROFILE_ID_REGEX = /^(anthropic|anthropic-oauth|openai|codex):[a-zA-Z0-9._-]+$/

export interface ProfileConfig {
  id: string
  provider: LLMProvider
  displayName: string
  enabled: boolean
  apiKey?: string
  claudeAuthToken?: string
  anthropicOAuthRefreshToken?: string
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

export interface ContextManagementPolicy {
  mode: ContextCompactionMode
  maxContextTokens: number
  compactionThreshold: number
  targetContextRatio: number
  keepRecentMessages: number
  minRecentMessages: number
  runningSummaryThreshold: number
  summaryMaxTokens: number
  transcriptMaxChars: number
}

export interface ToolCompactionPolicy {
  mode: ToolCompactionMode
  thresholdTokens: number
  summaryMaxTokens: number
  summaryInputMaxChars: number
  truncateMaxChars: number
}

export interface AppConfig {
  profiles: ProfileConfig[]
  routing: RoutingPolicy
  conversations: Record<string, ConversationRouteState>
  contextManagement: ContextManagementPolicy
  toolCompaction: ToolCompactionPolicy
  updatedAt?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementPolicy = {
  mode: 'summary',
  maxContextTokens: 150000,
  compactionThreshold: 0.75,
  targetContextRatio: 0.1,
  keepRecentMessages: 10,
  minRecentMessages: 4,
  runningSummaryThreshold: 0.35,
  summaryMaxTokens: 1200,
  transcriptMaxChars: 120000,
}

const DEFAULT_TOOL_COMPACTION: ToolCompactionPolicy = {
  mode: 'summary',
  thresholdTokens: 2000,
  summaryMaxTokens: 1000,
  summaryInputMaxChars: 50000,
  truncateMaxChars: 8000,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeContextMode(value: unknown): ContextCompactionMode {
  if (value === 'off' || value === 'truncate' || value === 'summary' || value === 'running-summary') {
    return value
  }
  return DEFAULT_CONTEXT_MANAGEMENT.mode
}

function normalizeToolCompactionMode(value: unknown): ToolCompactionMode {
  if (value === 'off' || value === 'summary' || value === 'truncate') {
    return value
  }
  return DEFAULT_TOOL_COMPACTION.mode
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeContextManagement(
  context: Partial<ContextManagementPolicy> | undefined,
): ContextManagementPolicy {
  const mode = normalizeContextMode(context?.mode)
  const maxContextTokens = clamp(
    Math.floor(toFiniteNumber(context?.maxContextTokens, DEFAULT_CONTEXT_MANAGEMENT.maxContextTokens)),
    1024,
    2_000_000,
  )
  const targetContextRatio = clamp(
    toFiniteNumber(context?.targetContextRatio, DEFAULT_CONTEXT_MANAGEMENT.targetContextRatio),
    0.02,
    0.95,
  )
  const compactionThreshold = clamp(
    toFiniteNumber(context?.compactionThreshold, DEFAULT_CONTEXT_MANAGEMENT.compactionThreshold),
    targetContextRatio + 0.02,
    0.99,
  )
  const keepRecentMessages = clamp(
    Math.floor(toFiniteNumber(context?.keepRecentMessages, DEFAULT_CONTEXT_MANAGEMENT.keepRecentMessages)),
    1,
    200,
  )
  const minRecentMessages = clamp(
    Math.floor(toFiniteNumber(context?.minRecentMessages, DEFAULT_CONTEXT_MANAGEMENT.minRecentMessages)),
    1,
    keepRecentMessages,
  )
  const runningSummaryThreshold = clamp(
    toFiniteNumber(context?.runningSummaryThreshold, DEFAULT_CONTEXT_MANAGEMENT.runningSummaryThreshold),
    targetContextRatio + 0.01,
    compactionThreshold,
  )
  const summaryMaxTokens = clamp(
    Math.floor(toFiniteNumber(context?.summaryMaxTokens, DEFAULT_CONTEXT_MANAGEMENT.summaryMaxTokens)),
    200,
    4000,
  )
  const transcriptMaxChars = clamp(
    Math.floor(toFiniteNumber(context?.transcriptMaxChars, DEFAULT_CONTEXT_MANAGEMENT.transcriptMaxChars)),
    4000,
    500000,
  )

  return {
    mode,
    maxContextTokens,
    compactionThreshold,
    targetContextRatio,
    keepRecentMessages,
    minRecentMessages,
    runningSummaryThreshold,
    summaryMaxTokens,
    transcriptMaxChars,
  }
}

function normalizeToolCompaction(
  toolCompaction: Partial<ToolCompactionPolicy> | undefined,
): ToolCompactionPolicy {
  return {
    mode: normalizeToolCompactionMode(toolCompaction?.mode),
    thresholdTokens: clamp(
      Math.floor(toFiniteNumber(toolCompaction?.thresholdTokens, DEFAULT_TOOL_COMPACTION.thresholdTokens)),
      1,
      1_000_000,
    ),
    summaryMaxTokens: clamp(
      Math.floor(toFiniteNumber(toolCompaction?.summaryMaxTokens, DEFAULT_TOOL_COMPACTION.summaryMaxTokens)),
      100,
      4000,
    ),
    summaryInputMaxChars: clamp(
      Math.floor(toFiniteNumber(toolCompaction?.summaryInputMaxChars, DEFAULT_TOOL_COMPACTION.summaryInputMaxChars)),
      1000,
      500000,
    ),
    truncateMaxChars: clamp(
      Math.floor(toFiniteNumber(toolCompaction?.truncateMaxChars, DEFAULT_TOOL_COMPACTION.truncateMaxChars)),
      500,
      200000,
    ),
  }
}

function defaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic' || provider === 'anthropic-oauth') return 'claude-sonnet-4-5'
  if (provider === 'openai') return 'gpt-4o'
  return 'gpt-5.3-codex'
}

function defaultAllowedModels(provider: LLMProvider): string[] {
  if (provider === 'anthropic' || provider === 'anthropic-oauth') {
    return ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5']
  }
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
    contextManagement: { ...DEFAULT_CONTEXT_MANAGEMENT },
    toolCompaction: { ...DEFAULT_TOOL_COMPACTION },
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
    contextManagement: { ...DEFAULT_CONTEXT_MANAGEMENT },
    toolCompaction: { ...DEFAULT_TOOL_COMPACTION },
    updatedAt: legacy.updatedAt,
  })
}

export function validateProfileId(id: string): boolean {
  return PROFILE_ID_REGEX.test(id)
}

export function validateProfile(profile: ProfileConfig): void {
  if (!validateProfileId(profile.id)) {
    throw new Error('Profile id must match ^(anthropic|anthropic-oauth|openai|codex):[a-zA-Z0-9._-]+$')
  }
  if (!profile.id.startsWith(`${profile.provider}:`)) {
    throw new Error('Profile id prefix must match provider')
  }
  if (profile.requiredFirstSystemPrompt) {
    const idx = profile.systemPrompts.findIndex((p) => p === profile.requiredFirstSystemPrompt)
    // Only enforce position if the required prompt is present in the editable list.
    if (idx > 0) {
      throw new Error('requiredFirstSystemPrompt must be first in systemPrompts')
    }
  }
}

export function validateRequiredPrompt(profile: ProfileConfig): void {
  if (!profile.requiredFirstSystemPrompt) return
  const idx = profile.systemPrompts.findIndex((p) => p === profile.requiredFirstSystemPrompt)
  // If it's present in editable prompts, it must remain first.
  if (idx > 0) {
    throw new Error('requiredFirstSystemPrompt cannot be reordered from first position')
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
    contextManagement: normalizeContextManagement(config.contextManagement),
    toolCompaction: normalizeToolCompaction(config.toolCompaction),
    updatedAt: config.updatedAt,
  }
}

export async function readConfig(): Promise<AppConfig> {
  const maxReadAttempts = 3

  for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
    try {
      const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && 'profiles' in (raw as Record<string, unknown>)) {
        return normalizeConfig(raw as AppConfig)
      }
      const migrated = migrateLegacy(raw)
      await writeConfig(migrated)
      return migrated
    } catch (error) {
      const errno = error as NodeJS.ErrnoException
      if (errno?.code === 'ENOENT') {
        return defaultConfig()
      }

      const isLastAttempt = attempt === maxReadAttempts
      if (!isLastAttempt) {
        await sleep(15 * attempt)
        continue
      }

      throw error
    }
  }

  return defaultConfig()
}

export async function writeConfig(config: AppConfig): Promise<void> {
  const configDir = path.dirname(CONFIG_PATH)
  await fs.mkdir(configDir, { recursive: true })
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() })
  const payload = JSON.stringify(normalized, null, 2)
  const tempPath = path.join(
    configDir,
    `.providers.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )

  try {
    await fs.writeFile(tempPath, payload, 'utf8')
    await fs.rename(tempPath, CONFIG_PATH)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
  }
}

export async function upsertConversationRoute(
  conversationId: string,
  state: ConversationRouteState,
): Promise<void> {
  const config = await readConfig()
  const existing = config.conversations[conversationId]
  if (existing?.activeProfileId === state.activeProfileId && existing?.activeModelId === state.activeModelId) {
    return
  }
  config.conversations[conversationId] = state
  await writeConfig(config)
}

function sanitizeProfile(profile: ProfileConfig): ProfileConfig {
  return {
    ...profile,
    apiKey: profile.apiKey ? SECRET_MASK : undefined,
    claudeAuthToken: profile.claudeAuthToken ? SECRET_MASK : undefined,
    anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken ? SECRET_MASK : undefined,
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
  const secretKeys: Array<keyof ProfileConfig> = ['apiKey', 'claudeAuthToken', 'anthropicOAuthRefreshToken', 'codexClientId', 'codexClientSecret', 'codexRefreshToken']
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
    'anthropic-oauth': config.profiles.find((p) => p.provider === 'anthropic-oauth'),
    openai: config.profiles.find((p) => p.provider === 'openai'),
    codex: config.profiles.find((p) => p.provider === 'codex'),
  }
}
