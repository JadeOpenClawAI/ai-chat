/* eslint-disable max-len */
import fs from 'fs/promises';
import path from 'path';
import type { LLMProvider } from '@/lib/types';
import type { ContextCompactionMode, ToolCompactionMode } from '@/lib/types';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'providers.json');
const SECRET_MASK = '***';
export const PROFILE_ID_REGEX = /^(anthropic|anthropic-oauth|openai|codex|xai|google-antigravity|google-gemini-cli):[a-zA-Z0-9._-]+$/;

export interface ProfileConfig {
  id: string;
  provider: LLMProvider;
  displayName: string;
  enabled: boolean;
  apiKey?: string;
  claudeAuthToken?: string;
  anthropicOAuthRefreshToken?: string;
  codexClientId?: string;
  codexClientSecret?: string;
  codexRefreshToken?: string;
  googleOAuthRefreshToken?: string;
  googleOAuthAccessToken?: string;
  googleOAuthProjectId?: string;
  googleOAuthEmail?: string;
  googleOAuthExpiresAt?: number;
  baseUrl?: string;
  useResponsesApi?: boolean;
  rejectUnauthorized?: boolean;
  extraHeaders?: Record<string, string>;
  allowedModels: string[];
  requiredFirstSystemPrompt?: string;
  systemPrompts: string[];
}

export interface RouteTarget {
  profileId: string;
  modelId: string;
}

export interface ActivityRoutingProfile {
  id: string;
  label: string;
  modelPriority: RouteTarget[];
}

export interface RoutingPolicy {
  activityProfiles: ActivityRoutingProfile[];
  defaultActivityProfileId: string;
  maxAttempts: number;
}

export interface ConversationRouteState {
  activeProfileId: string;
  activeModelId: string;
  autoActivityId: string;
}

export interface ContextManagementPolicy {
  mode: ContextCompactionMode;
  maxContextTokens: number;
  compactionThreshold: number;
  targetContextRatio: number;
  keepRecentMessages: number;
  minRecentMessages: number;
  runningSummaryThreshold: number;
  summaryMaxTokens: number;
  transcriptMaxChars: number;
}

export interface ToolCompactionPolicy {
  mode: ToolCompactionMode;
  thresholdTokens: number;
  summaryMaxTokens: number;
  summaryInputMaxChars: number;
  truncateMaxChars: number;
}

export interface ApiEndpointsConfig {
  enableOpenAICompat: boolean;
  enableAnthropicCompat: boolean;
  /** Optional bearer token required for requests to the compat endpoints */
  endpointApiKey?: string;
}

export interface CrossTabSyncPolicy {
  enabled: boolean;
  syncMessages: boolean;
  syncConversationSelection: boolean;
  syncSidebarOpen: boolean;
  syncSubAgentPanel: boolean;
  syncHistory: boolean;
  syncStreamingState: boolean;
  syncStopRequests: boolean;
  syncDraftInput: boolean;
}

export interface UISettingsPolicy {
  aiConversationTitles: boolean;
  aiTitleUpdateEveryMessages: number;
  aiTitleEagerUpdatesForFirstMessages: number;
}

export interface AgentExecutionPolicy {
  maxSteps: number;
  maxSubAgentSteps: number;
}

export interface AppConfig {
  profiles: ProfileConfig[];
  routing: RoutingPolicy;
  conversations: Record<string, ConversationRouteState>;
  contextManagement: ContextManagementPolicy;
  toolCompaction: ToolCompactionPolicy;
  apiEndpoints: ApiEndpointsConfig;
  crossTabSync: CrossTabSyncPolicy;
  uiSettings: UISettingsPolicy;
  agentExecution: AgentExecutionPolicy;
  updatedAt?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
};

const DEFAULT_API_ENDPOINTS: ApiEndpointsConfig = {
  enableOpenAICompat: false,
  enableAnthropicCompat: false,
};

const DEFAULT_CROSS_TAB_SYNC: CrossTabSyncPolicy = {
  enabled: true,
  syncMessages: true,
  syncConversationSelection: true,
  syncSidebarOpen: true,
  syncSubAgentPanel: true,
  syncHistory: true,
  syncStreamingState: true,
  syncStopRequests: true,
  syncDraftInput: true,
};

const DEFAULT_UI_SETTINGS: UISettingsPolicy = {
  aiConversationTitles: true,
  aiTitleUpdateEveryMessages: 4,
  aiTitleEagerUpdatesForFirstMessages: 5,
};

const DEFAULT_AGENT_EXECUTION: AgentExecutionPolicy = {
  maxSteps: 10,
  maxSubAgentSteps: 10,
};

const DEFAULT_TOOL_COMPACTION: ToolCompactionPolicy = {
  mode: 'summary',
  thresholdTokens: 2000,
  summaryMaxTokens: 1000,
  summaryInputMaxChars: 50000,
  truncateMaxChars: 8000,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeContextMode(value: unknown): ContextCompactionMode {
  if (value === 'off' || value === 'truncate' || value === 'summary' || value === 'running-summary') {
    return value;
  }
  return DEFAULT_CONTEXT_MANAGEMENT.mode;
}

function normalizeToolCompactionMode(value: unknown): ToolCompactionMode {
  if (value === 'off' || value === 'summary' || value === 'truncate') {
    return value;
  }
  return DEFAULT_TOOL_COMPACTION.mode;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeContextManagement(
  context: Partial<ContextManagementPolicy> | undefined,
): ContextManagementPolicy {
  const mode = normalizeContextMode(context?.mode);
  const maxContextTokens = clamp(
    Math.floor(toFiniteNumber(context?.maxContextTokens, DEFAULT_CONTEXT_MANAGEMENT.maxContextTokens)),
    1024,
    2_000_000,
  );
  const targetContextRatio = clamp(
    toFiniteNumber(context?.targetContextRatio, DEFAULT_CONTEXT_MANAGEMENT.targetContextRatio),
    0.02,
    0.95,
  );
  const compactionThreshold = clamp(
    toFiniteNumber(context?.compactionThreshold, DEFAULT_CONTEXT_MANAGEMENT.compactionThreshold),
    targetContextRatio + 0.02,
    0.99,
  );
  const keepRecentMessages = clamp(
    Math.floor(toFiniteNumber(context?.keepRecentMessages, DEFAULT_CONTEXT_MANAGEMENT.keepRecentMessages)),
    1,
    200,
  );
  const minRecentMessages = clamp(
    Math.floor(toFiniteNumber(context?.minRecentMessages, DEFAULT_CONTEXT_MANAGEMENT.minRecentMessages)),
    1,
    keepRecentMessages,
  );
  const runningSummaryThreshold = clamp(
    toFiniteNumber(context?.runningSummaryThreshold, DEFAULT_CONTEXT_MANAGEMENT.runningSummaryThreshold),
    targetContextRatio + 0.01,
    compactionThreshold,
  );
  const summaryMaxTokens = clamp(
    Math.floor(toFiniteNumber(context?.summaryMaxTokens, DEFAULT_CONTEXT_MANAGEMENT.summaryMaxTokens)),
    200,
    4000,
  );
  const transcriptMaxChars = clamp(
    Math.floor(toFiniteNumber(context?.transcriptMaxChars, DEFAULT_CONTEXT_MANAGEMENT.transcriptMaxChars)),
    4000,
    500000,
  );

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
  };
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
  };
}

function normalizeCrossTabSync(
  crossTabSync: Partial<CrossTabSyncPolicy> | undefined,
): CrossTabSyncPolicy {
  return {
    enabled: crossTabSync?.enabled ?? DEFAULT_CROSS_TAB_SYNC.enabled,
    syncMessages: crossTabSync?.syncMessages ?? DEFAULT_CROSS_TAB_SYNC.syncMessages,
    syncConversationSelection:
      crossTabSync?.syncConversationSelection ?? DEFAULT_CROSS_TAB_SYNC.syncConversationSelection,
    syncSidebarOpen: crossTabSync?.syncSidebarOpen ?? DEFAULT_CROSS_TAB_SYNC.syncSidebarOpen,
    syncSubAgentPanel: crossTabSync?.syncSubAgentPanel ?? DEFAULT_CROSS_TAB_SYNC.syncSubAgentPanel,
    syncHistory: crossTabSync?.syncHistory ?? DEFAULT_CROSS_TAB_SYNC.syncHistory,
    syncStreamingState: crossTabSync?.syncStreamingState ?? DEFAULT_CROSS_TAB_SYNC.syncStreamingState,
    syncStopRequests: crossTabSync?.syncStopRequests ?? DEFAULT_CROSS_TAB_SYNC.syncStopRequests,
    syncDraftInput: crossTabSync?.syncDraftInput ?? DEFAULT_CROSS_TAB_SYNC.syncDraftInput,
  };
}

function normalizeUISettings(
  uiSettings: Partial<UISettingsPolicy> | undefined,
): UISettingsPolicy {
  return {
    aiConversationTitles: uiSettings?.aiConversationTitles ?? DEFAULT_UI_SETTINGS.aiConversationTitles,
    aiTitleUpdateEveryMessages: clamp(
      Math.floor(toFiniteNumber(uiSettings?.aiTitleUpdateEveryMessages, DEFAULT_UI_SETTINGS.aiTitleUpdateEveryMessages)),
      1,
      50,
    ),
    aiTitleEagerUpdatesForFirstMessages: clamp(
      Math.floor(toFiniteNumber(uiSettings?.aiTitleEagerUpdatesForFirstMessages, DEFAULT_UI_SETTINGS.aiTitleEagerUpdatesForFirstMessages)),
      0,
      30,
    ),
  };
}

function normalizeAgentExecution(
  agentExecution: Partial<AgentExecutionPolicy> | undefined,
): AgentExecutionPolicy {
  return {
    maxSteps: clamp(
      Math.floor(toFiniteNumber(agentExecution?.maxSteps, DEFAULT_AGENT_EXECUTION.maxSteps)),
      1,
      200,
    ),
    maxSubAgentSteps: clamp(
      Math.floor(toFiniteNumber(agentExecution?.maxSubAgentSteps, DEFAULT_AGENT_EXECUTION.maxSubAgentSteps)),
      1,
      200,
    ),
  };
}

function defaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'anthropic' || provider === 'anthropic-oauth') {
    return 'claude-sonnet-4-5';
  }
  if (provider === 'openai') {
    return 'gpt-4o';
  }
  if (provider === 'xai') {
    return 'grok-4-1-fast-non-reasoning';
  }
  if (provider === 'google-antigravity') {
    return 'gemini-2.5-pro';
  }
  if (provider === 'google-gemini-cli') {
    return 'auto-gemini-3';
  }
  return 'gpt-5.3-codex';
}

function defaultAllowedModels(provider: LLMProvider): string[] {
  if (provider === 'anthropic' || provider === 'anthropic-oauth') {
    return ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'];
  }
  if (provider === 'openai') {
    return ['gpt-4o', 'gpt-4o-mini', 'o3-mini'];
  }
  if (provider === 'xai') {
    return [
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
      'grok-4-fast-reasoning',
      'grok-4-fast-non-reasoning',
      'grok-4-0709',
      'grok-3-mini',
      'grok-3',
    ];
  }
  if (provider === 'google-antigravity') {
    return ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'];
  }
  if (provider === 'google-gemini-cli') {
    return [
      'auto-gemini-3',
      'auto-gemini-2.5',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ];
  }
  return ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'];
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
      activityProfiles: [
        {
          id: 'general',
          label: 'General',
          modelPriority: [{ profileId: 'anthropic:default', modelId: 'claude-sonnet-4-5' }],
        },
      ],
      defaultActivityProfileId: 'general',
      maxAttempts: 3,
    },
    conversations: {},
    contextManagement: { ...DEFAULT_CONTEXT_MANAGEMENT },
    toolCompaction: { ...DEFAULT_TOOL_COMPACTION },
    apiEndpoints: { ...DEFAULT_API_ENDPOINTS },
    crossTabSync: { ...DEFAULT_CROSS_TAB_SYNC },
    uiSettings: { ...DEFAULT_UI_SETTINGS },
    agentExecution: { ...DEFAULT_AGENT_EXECUTION },
  };
}

export function validateProfileId(id: string): boolean {
  return PROFILE_ID_REGEX.test(id);
}

export function validateProfile(profile: ProfileConfig): void {
  if (!validateProfileId(profile.id)) {
    throw new Error('Profile id must match provider:[a-zA-Z0-9._-]+ format');
  }
  if (!profile.id.startsWith(`${profile.provider}:`)) {
    throw new Error('Profile id prefix must match provider');
  }
  if (profile.requiredFirstSystemPrompt) {
    const idx = profile.systemPrompts.findIndex((p) => p === profile.requiredFirstSystemPrompt);
    // Only enforce position if the required prompt is present in the editable list.
    if (idx > 0) {
      throw new Error('requiredFirstSystemPrompt must be first in systemPrompts');
    }
  }
}

export function validateRequiredPrompt(profile: ProfileConfig): void {
  if (!profile.requiredFirstSystemPrompt) {
    return;
  }
  const idx = profile.systemPrompts.findIndex((p) => p === profile.requiredFirstSystemPrompt);
  // If it's present in editable prompts, it must remain first.
  if (idx > 0) {
    throw new Error('requiredFirstSystemPrompt cannot be reordered from first position');
  }
}

export function composeSystemPrompt(profile: ProfileConfig, requestOverride?: string): string {
  return composeSystemPrompts(profile, requestOverride).join('\n\n').trim();
}

export function composeSystemPrompts(profile: ProfileConfig, requestOverride?: string): string[] {
  const parts: string[] = [];
  if (profile.requiredFirstSystemPrompt) {
    parts.push(profile.requiredFirstSystemPrompt);
  }
  for (const prompt of profile.systemPrompts) {
    if (!prompt.trim()) {
      continue;
    }
    if (profile.requiredFirstSystemPrompt && prompt === profile.requiredFirstSystemPrompt) {
      continue;
    }
    parts.push(prompt);
  }
  if (requestOverride?.trim() && !parts.includes(requestOverride.trim())) {
    parts.push(requestOverride.trim());
  }
  return parts;
}

function firstValidRouteTarget(profiles: ProfileConfig[]): RouteTarget {
  const fallbackProfile = profiles[0];
  return {
    profileId: fallbackProfile.id,
    modelId: fallbackProfile.allowedModels[0] ?? defaultModelForProvider(fallbackProfile.provider),
  };
}

function defaultRoutingForProfiles(profiles: ProfileConfig[]): RoutingPolicy {
  const target = firstValidRouteTarget(profiles);
  return {
    activityProfiles: [
      {
        id: 'general',
        label: 'General',
        modelPriority: [target],
      },
    ],
    defaultActivityProfileId: 'general',
    maxAttempts: 3,
  };
}

function normalizeRouting(
  routing: unknown,
  profiles: ProfileConfig[],
): RoutingPolicy {
  if (!routing || typeof routing !== 'object') {
    return defaultRoutingForProfiles(profiles);
  }
  const candidate = routing as Partial<RoutingPolicy>;
  if (
    !Array.isArray(candidate.activityProfiles)
    || typeof candidate.defaultActivityProfileId !== 'string'
  ) {
    return defaultRoutingForProfiles(profiles);
  }

  const fallbackTarget = firstValidRouteTarget(profiles);
  const normalizedActivities = candidate.activityProfiles
    .filter((activity) => activity && typeof activity.id === 'string' && typeof activity.label === 'string')
    .map((activity) => {
      const dedup = new Set<string>();
      const modelPriority = (Array.isArray(activity.modelPriority) ? activity.modelPriority : [])
        .filter((target) => (
          target
          && typeof target.profileId === 'string'
          && typeof target.modelId === 'string'
          && profiles.some((profile) => profile.id === target.profileId)
          && target.modelId.trim().length > 0
        ))
        .filter((target) => {
          const key = `${target.profileId}/${target.modelId}`;
          if (dedup.has(key)) {
            return false;
          }
          dedup.add(key);
          return true;
        });

      return {
        id: activity.id.trim(),
        label: activity.label.trim() || activity.id.trim(),
        modelPriority: modelPriority.length > 0 ? modelPriority : [fallbackTarget],
      };
    })
    .filter((activity) => activity.id.length > 0);

  if (normalizedActivities.length === 0) {
    return defaultRoutingForProfiles(profiles);
  }

  const defaultActivityProfileId = normalizedActivities.some((activity) => activity.id === candidate.defaultActivityProfileId)
    ? candidate.defaultActivityProfileId
    : normalizedActivities[0]!.id;

  return {
    activityProfiles: normalizedActivities,
    defaultActivityProfileId,
    maxAttempts: Math.max(1, toFiniteNumber(candidate.maxAttempts, 3)),
  };
}

export function normalizeConfig(config: AppConfig): AppConfig {
  const validProfiles = config.profiles.filter((profile) => {
    try {
      validateProfile({
        ...profile,
        enabled: profile.enabled ?? true,
        allowedModels: profile.allowedModels ?? defaultAllowedModels(profile.provider),
        systemPrompts: profile.systemPrompts ?? [],
      });
      return true;
    } catch {
      return false;
    }
  });

  const profiles = validProfiles.length > 0 ? validProfiles : defaultConfig().profiles;
  const routing = normalizeRouting(config.routing, profiles);
  const validActivityIds = new Set(routing.activityProfiles.map((activity) => activity.id));
  const fallbackActivityId = routing.defaultActivityProfileId;

  return {
    profiles: profiles.map((p) => ({
      ...p,
      enabled: p.enabled ?? true,
      allowedModels: p.allowedModels ?? defaultAllowedModels(p.provider),
      systemPrompts: p.systemPrompts ?? [],
    })),
    routing,
    conversations: Object.fromEntries(
      Object.entries(config.conversations ?? {})
        .filter(([, state]) => (
          state
          && typeof state.activeProfileId === 'string'
          && typeof state.activeModelId === 'string'
          && profiles.some((p) => p.id === state.activeProfileId)
          && state.activeModelId.trim().length > 0
        ))
        .map(([conversationId, state]) => {
          const autoActivityId = typeof state.autoActivityId === 'string' && validActivityIds.has(state.autoActivityId)
            ? state.autoActivityId
            : fallbackActivityId;
          return [conversationId, {
            activeProfileId: state.activeProfileId,
            activeModelId: state.activeModelId,
            autoActivityId,
          } satisfies ConversationRouteState];
        }),
    ),
    contextManagement: normalizeContextManagement(config.contextManagement),
    toolCompaction: normalizeToolCompaction(config.toolCompaction),
    apiEndpoints: {
      enableOpenAICompat: (config.apiEndpoints as ApiEndpointsConfig | undefined)?.enableOpenAICompat ?? DEFAULT_API_ENDPOINTS.enableOpenAICompat,
      enableAnthropicCompat: (config.apiEndpoints as ApiEndpointsConfig | undefined)?.enableAnthropicCompat ?? DEFAULT_API_ENDPOINTS.enableAnthropicCompat,
      endpointApiKey: (config.apiEndpoints as ApiEndpointsConfig | undefined)?.endpointApiKey || undefined,
    },
    crossTabSync: normalizeCrossTabSync(config.crossTabSync),
    uiSettings: normalizeUISettings(config.uiSettings),
    agentExecution: normalizeAgentExecution(config.agentExecution),
    updatedAt: config.updatedAt,
  };
}

export async function readConfig(): Promise<AppConfig> {
  const maxReadAttempts = 3;

  for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
    try {
      const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || !('profiles' in (raw as Record<string, unknown>))) {
        return defaultConfig();
      }
      return normalizeConfig(raw as AppConfig);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno?.code === 'ENOENT') {
        return defaultConfig();
      }

      const isLastAttempt = attempt === maxReadAttempts;
      if (!isLastAttempt) {
        await sleep(15 * attempt);
        continue;
      }

      throw error;
    }
  }

  return defaultConfig();
}

export async function writeConfig(config: AppConfig): Promise<void> {
  const configDir = path.dirname(CONFIG_PATH);
  await fs.mkdir(configDir, { recursive: true });
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() });
  const payload = JSON.stringify(normalized, null, 2);
  const tempPath = path.join(
    configDir,
    `.providers.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, CONFIG_PATH);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function upsertConversationRoute(
  conversationId: string,
  state: ConversationRouteState,
): Promise<void> {
  const config = await readConfig();
  const existing = config.conversations[conversationId];
  if (
    existing?.activeProfileId === state.activeProfileId
    && existing?.activeModelId === state.activeModelId
    && existing?.autoActivityId === state.autoActivityId
  ) {
    return;
  }
  config.conversations[conversationId] = state;
  await writeConfig(config);
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
    googleOAuthRefreshToken: profile.googleOAuthRefreshToken ? SECRET_MASK : undefined,
    googleOAuthAccessToken: profile.googleOAuthAccessToken ? SECRET_MASK : undefined,
  };
}

export function sanitizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    profiles: config.profiles.map(sanitizeProfile),
    apiEndpoints: {
      ...config.apiEndpoints,
      endpointApiKey: config.apiEndpoints?.endpointApiKey ? SECRET_MASK : undefined,
    },
  };
}

export function mergeProfileSecrets(existing: ProfileConfig | undefined, incoming: ProfileConfig): ProfileConfig {
  const merged = { ...incoming };
  const secretKeys: Array<keyof ProfileConfig> = ['apiKey', 'claudeAuthToken', 'anthropicOAuthRefreshToken', 'codexClientId', 'codexClientSecret', 'codexRefreshToken', 'googleOAuthRefreshToken', 'googleOAuthAccessToken'];
  for (const key of secretKeys) {
    if (incoming[key] === SECRET_MASK && existing?.[key]) {
      ;(merged as Record<string, unknown>)[key] = existing[key];
    }
  }
  return merged;
}

export function getProfileById(config: AppConfig, profileId: string): ProfileConfig | undefined {
  return config.profiles.find((p) => p.id === profileId);
}

export function getLegacyProviderView(config: AppConfig): Partial<Record<LLMProvider, ProfileConfig>> {
  return {
    anthropic: config.profiles.find((p) => p.provider === 'anthropic'),
    'anthropic-oauth': config.profiles.find((p) => p.provider === 'anthropic-oauth'),
    openai: config.profiles.find((p) => p.provider === 'openai'),
    codex: config.profiles.find((p) => p.provider === 'codex'),
    xai: config.profiles.find((p) => p.provider === 'xai'),
    'google-antigravity': config.profiles.find((p) => p.provider === 'google-antigravity'),
    'google-gemini-cli': config.profiles.find((p) => p.provider === 'google-gemini-cli'),
  };
}
