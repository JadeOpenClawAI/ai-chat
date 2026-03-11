import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import {
  getProfileById,
  normalizeConfig,
  readConfig,
  sanitizeConfig,
  validateProfile,
  writeConfig,
  type AgentExecutionPolicy,
  type ApiEndpointsConfig,
  type AppConfig,
  type ContextManagementPolicy,
  type CrossTabSyncPolicy,
  type ModelBehaviorPolicy,
  type ProfileConfig,
  type RoutingPolicy,
  type ToolCompactionPolicy,
  type UISettingsPolicy,
} from '@/lib/config/store';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

const SECRET_MASK = '***';

const SETTINGS_SECTIONS = [
  'profiles',
  'routing',
  'contextManagement',
  'toolCompaction',
  'apiEndpoints',
  'crossTabSync',
  'uiSettings',
  'modelBehavior',
  'agentExecution',
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const PROFILE_OPERATIONS = ['create', 'update', 'delete'] as const;

type ProfileOperation = (typeof PROFILE_OPERATIONS)[number];

const PROVIDERS = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'codex',
  'xai',
  'google-antigravity',
  'google-gemini-cli',
] as const;

const routeTargetSchema = z.object({
  profileId: z.string().min(1),
  modelId: z.string().min(1),
}).strict();

const activityRoutingProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  modelPriority: z.array(routeTargetSchema).min(1),
}).strict();

const routingPatchSchema = z.object({
  activityProfiles: z.array(activityRoutingProfileSchema).min(1).optional(),
  defaultActivityProfileId: z.string().min(1).optional(),
  maxAttempts: z.number().int().min(1).optional(),
}).strict();

const contextManagementPatchSchema = z.object({
  mode: z.enum(['off', 'truncate', 'summary', 'running-summary']).optional(),
  maxContextTokens: z.number().int().min(1024).max(2_000_000).optional(),
  compactionThreshold: z.number().min(0.02).max(0.99).optional(),
  targetContextRatio: z.number().min(0.02).max(0.95).optional(),
  keepRecentMessages: z.number().int().min(1).max(200).optional(),
  minRecentMessages: z.number().int().min(1).max(200).optional(),
  runningSummaryThreshold: z.number().min(0.02).max(0.99).optional(),
  summaryMaxTokens: z.number().int().min(200).max(4000).optional(),
  transcriptMaxChars: z.number().int().min(4000).max(500000).optional(),
}).strict();

const toolCompactionPatchSchema = z.object({
  mode: z.enum(['off', 'summary', 'truncate']).optional(),
  thresholdTokens: z.number().int().min(1).max(1_000_000).optional(),
  summaryMaxTokens: z.number().int().min(100).max(4000).optional(),
  summaryInputMaxChars: z.number().int().min(1000).max(500000).optional(),
  truncateMaxChars: z.number().int().min(500).max(200000).optional(),
}).strict();

const apiEndpointsPatchSchema = z.object({
  enableOpenAICompat: z.boolean().optional(),
  enableAnthropicCompat: z.boolean().optional(),
}).strict();

const crossTabSyncPatchSchema = z.object({
  enabled: z.boolean().optional(),
  syncMessages: z.boolean().optional(),
  syncConversationSelection: z.boolean().optional(),
  syncSidebarOpen: z.boolean().optional(),
  syncSubAgentPanel: z.boolean().optional(),
  syncHistory: z.boolean().optional(),
  syncStreamingState: z.boolean().optional(),
  syncStopRequests: z.boolean().optional(),
  syncDraftInput: z.boolean().optional(),
}).strict();

const uiSettingsPatchSchema = z.object({
  aiConversationTitles: z.boolean().optional(),
  aiTitleUpdateEveryMessages: z.number().int().min(1).max(50).optional(),
  aiTitleEagerUpdatesForFirstMessages: z.number().int().min(0).max(30).optional(),
  mastraMemoryScope: z.enum(['all-conversations', 'per-conversation']).optional(),
}).strict();

const agentExecutionPatchSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).optional(),
  maxSubAgentSteps: z.number().int().min(1).max(200).optional(),
}).strict();

const modelSamplingPatchSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(1000).optional(),
}).strict();

const modelBehaviorOverridePatchSchema = z.object({
  systemPrompts: z.array(z.string()).optional(),
  sampling: modelSamplingPatchSchema.optional(),
}).strict();

const modelBehaviorPatchSchema = z.object({
  globalSystemPrompts: z.array(z.string()).optional(),
  defaultSampling: modelSamplingPatchSchema.optional(),
  modelOverrides: z.record(modelBehaviorOverridePatchSchema).optional(),
}).strict();

const profileCreatePatchSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(PROVIDERS),
  displayName: z.string(),
  enabled: z.boolean(),
  anthropicOAuthExpiresAt: z.number().int().optional(),
  googleOAuthProjectId: z.string().optional(),
  googleOAuthEmail: z.string().optional(),
  googleOAuthExpiresAt: z.number().int().optional(),
  baseUrl: z.string().optional(),
  useResponsesApi: z.boolean().optional(),
  rejectUnauthorized: z.boolean().optional(),
  extraHeaders: z.record(z.string()).optional(),
  allowedModels: z.array(z.string().min(1)).min(1),
  requiredFirstSystemPrompt: z.string().optional(),
  systemPrompts: z.array(z.string()),
}).strict();

const profileUpdatePatchSchema = profileCreatePatchSchema.partial();

const profileSecretUpdatesSchema = z.object({
  apiKey: z.string().optional(),
  claudeAuthToken: z.string().optional(),
  anthropicOAuthRefreshToken: z.string().optional(),
  codexClientId: z.string().optional(),
  codexClientSecret: z.string().optional(),
  codexRefreshToken: z.string().optional(),
  googleOAuthRefreshToken: z.string().optional(),
  googleOAuthAccessToken: z.string().optional(),
}).strict();

const apiEndpointSecretUpdatesSchema = z.object({
  endpointApiKey: z.string().optional(),
}).strict();

const settingsConfigInputSchema = z.object({
  action: z.enum(['view', 'edit']),
  section: z.enum(SETTINGS_SECTIONS).nullable().optional(),
  profileOp: z.enum(PROFILE_OPERATIONS).nullable().optional(),
  profileId: z.string().nullable().optional(),
  patch: z.record(z.unknown()).nullable().optional(),
  secretUpdates: z.record(z.unknown()).nullable().optional(),
  expectedUpdatedAt: z.string().nullable().optional(),
  dryRun: z.boolean().nullable().optional(),
}).strict();

type SettingsConfigInput = z.infer<typeof settingsConfigInputSchema>;

type ProfileSecretUpdates = z.infer<typeof profileSecretUpdatesSchema>;
type ApiEndpointSecretUpdates = z.infer<typeof apiEndpointSecretUpdatesSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function hasAnyKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function formatValidationError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) {
    return 'Validation failed';
  }
  const path = first.path.length > 0 ? first.path.join('.') : 'input';
  return `${path}: ${first.message}`;
}

function getSectionConfig(config: AppConfig, section: SettingsSection | undefined | null): AppConfig | Partial<AppConfig> {
  if (!section) {
    return config;
  }
  return { [section]: config[section] };
}

function assertNoNormalizationChanges(next: AppConfig): void {
  const normalized = normalizeConfig(next);
  if (JSON.stringify(next) !== JSON.stringify(normalized)) {
    throw new Error('Edit rejected because normalization would alter the provided values. Provide valid explicit values.');
  }
}

function assertProfileReferences(config: AppConfig): void {
  const profileIds = new Set(config.profiles.map((profile) => profile.id));

  for (const activity of config.routing.activityProfiles) {
    if (!activity.id.trim()) {
      throw new Error('routing.activityProfiles contains an entry with an empty id');
    }
    if (!activity.label.trim()) {
      throw new Error(`routing.activityProfiles.${activity.id} has an empty label`);
    }
    for (const target of activity.modelPriority) {
      if (!profileIds.has(target.profileId)) {
        throw new Error(`routing.activityProfiles.${activity.id}.modelPriority references unknown profileId: ${target.profileId}`);
      }
    }
  }

  if (!config.routing.activityProfiles.some((activity) => activity.id === config.routing.defaultActivityProfileId)) {
    throw new Error(`routing.defaultActivityProfileId references unknown activity profile: ${config.routing.defaultActivityProfileId}`);
  }

  for (const [conversationId, state] of Object.entries(config.conversations)) {
    if (!profileIds.has(state.activeProfileId)) {
      throw new Error(`conversations.${conversationId} references unknown activeProfileId: ${state.activeProfileId}`);
    }
    if (!config.routing.activityProfiles.some((activity) => activity.id === state.autoActivityId)) {
      throw new Error(`conversations.${conversationId} references unknown autoActivityId: ${state.autoActivityId}`);
    }
  }
}

function applySecret(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming === undefined || incoming === SECRET_MASK) {
    return existing;
  }
  const trimmed = incoming.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProfileSecretUpdates(raw: unknown): ProfileSecretUpdates {
  if (raw === null || raw === undefined) {
    return {};
  }
  return profileSecretUpdatesSchema.parse(requirePlainObject(raw, 'secretUpdates'));
}

function parseApiEndpointSecretUpdates(raw: unknown): ApiEndpointSecretUpdates {
  if (raw === null || raw === undefined) {
    return {};
  }
  return apiEndpointSecretUpdatesSchema.parse(requirePlainObject(raw, 'secretUpdates'));
}

function applyProfileSecretUpdates(profile: ProfileConfig, updates: ProfileSecretUpdates): ProfileConfig {
  return {
    ...profile,
    apiKey: applySecret(profile.apiKey, updates.apiKey),
    claudeAuthToken: applySecret(profile.claudeAuthToken, updates.claudeAuthToken),
    anthropicOAuthRefreshToken: applySecret(profile.anthropicOAuthRefreshToken, updates.anthropicOAuthRefreshToken),
    codexClientId: applySecret(profile.codexClientId, updates.codexClientId),
    codexClientSecret: applySecret(profile.codexClientSecret, updates.codexClientSecret),
    codexRefreshToken: applySecret(profile.codexRefreshToken, updates.codexRefreshToken),
    googleOAuthRefreshToken: applySecret(profile.googleOAuthRefreshToken, updates.googleOAuthRefreshToken),
    googleOAuthAccessToken: applySecret(profile.googleOAuthAccessToken, updates.googleOAuthAccessToken),
  };
}

function ensureNoSecretUpdates(raw: unknown, section: SettingsSection): void {
  if (raw === null || raw === undefined) {
    return;
  }
  const obj = requirePlainObject(raw, 'secretUpdates');
  if (Object.keys(obj).length > 0) {
    throw new Error(`secretUpdates is only supported for profiles and apiEndpoints sections (received section=${section})`);
  }
}

function parsePatch(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return {};
  }
  return requirePlainObject(raw, 'patch');
}

function applyProfilesEdit(
  config: AppConfig,
  profileOp: ProfileOperation | null | undefined,
  profileIdRaw: string | null | undefined,
  patchRaw: unknown,
  secretUpdatesRaw: unknown,
): void {
  if (!profileOp) {
    throw new Error('profileOp is required when section=profiles');
  }

  if (profileOp === 'create') {
    if (profileIdRaw) {
      throw new Error('profileId is not allowed for profileOp=create');
    }
    const patch = profileCreatePatchSchema.parse(parsePatch(patchRaw));
    if (getProfileById(config, patch.id)) {
      throw new Error(`Profile already exists: ${patch.id}`);
    }
    const secrets = parseProfileSecretUpdates(secretUpdatesRaw);
    const nextProfile = applyProfileSecretUpdates(patch as ProfileConfig, secrets);
    validateProfile(nextProfile);
    config.profiles.push(nextProfile);
    return;
  }

  if (!profileIdRaw) {
    throw new Error('profileId is required for profileOp=update|delete');
  }

  const idx = config.profiles.findIndex((profile) => profile.id === profileIdRaw);
  if (idx === -1) {
    throw new Error(`Profile not found: ${profileIdRaw}`);
  }

  if (profileOp === 'delete') {
    const patch = parsePatch(patchRaw);
    if (hasAnyKeys(patch)) {
      throw new Error('patch is not allowed for profileOp=delete');
    }
    const secrets = parseProfileSecretUpdates(secretUpdatesRaw);
    if (Object.keys(secrets).length > 0) {
      throw new Error('secretUpdates is not allowed for profileOp=delete');
    }

    if (config.profiles.length <= 1) {
      throw new Error('Cannot delete the last remaining profile');
    }

    config.profiles = config.profiles.filter((profile) => profile.id !== profileIdRaw);
    const fallbackProfile = config.profiles[0];
    const fallbackModelId = fallbackProfile.allowedModels[0] ?? 'claude-sonnet-4-5';
    config.routing.activityProfiles = config.routing.activityProfiles.map((activity) => {
      const filtered = activity.modelPriority.filter((target) => target.profileId !== profileIdRaw);
      return {
        ...activity,
        modelPriority: filtered.length > 0
          ? filtered
          : [{
            profileId: fallbackProfile.id,
            modelId: fallbackModelId,
          }],
      };
    });

    for (const [conversationId, state] of Object.entries(config.conversations)) {
      if (state.activeProfileId === profileIdRaw) {
        config.conversations[conversationId] = {
          activeProfileId: fallbackProfile.id,
          activeModelId: fallbackModelId,
          autoActivityId: state.autoActivityId,
        };
      }
    }
    return;
  }

  const existing = config.profiles[idx];
  const patch = profileUpdatePatchSchema.parse(parsePatch(patchRaw));
  const secrets = parseProfileSecretUpdates(secretUpdatesRaw);

  if (Object.keys(patch).length === 0 && Object.keys(secrets).length === 0) {
    throw new Error('No changes provided: patch and secretUpdates are both empty');
  }

  const renamedProfileId = patch.id ?? profileIdRaw;
  if (renamedProfileId !== profileIdRaw && getProfileById(config, renamedProfileId)) {
    throw new Error(`Profile ID already exists: ${renamedProfileId}`);
  }

  let merged = {
    ...existing,
    ...patch,
  } as ProfileConfig;

  if (existing.requiredFirstSystemPrompt && merged.requiredFirstSystemPrompt !== existing.requiredFirstSystemPrompt) {
    throw new Error('requiredFirstSystemPrompt is immutable once set');
  }

  merged = applyProfileSecretUpdates(merged, secrets);
  validateProfile(merged);

  config.profiles[idx] = merged;

  if (renamedProfileId !== profileIdRaw) {
    config.routing.activityProfiles = config.routing.activityProfiles.map((activity) => ({
      ...activity,
      modelPriority: activity.modelPriority.map((target) =>
        target.profileId === profileIdRaw ? { ...target, profileId: renamedProfileId } : target,
      ),
    }));

    for (const [conversationId, state] of Object.entries(config.conversations)) {
      if (state.activeProfileId === profileIdRaw) {
        config.conversations[conversationId] = {
          ...state,
          activeProfileId: renamedProfileId,
        };
      }
    }
  }
}

function applySectionEdit(config: AppConfig, input: SettingsConfigInput): SettingsSection {
  const section = input.section;
  if (!section) {
    throw new Error('section is required for edit action');
  }

  if (section === 'profiles') {
    applyProfilesEdit(config, input.profileOp, input.profileId, input.patch, input.secretUpdates);
    return section;
  }

  if (input.profileOp) {
    throw new Error('profileOp is only valid when section=profiles');
  }
  if (input.profileId) {
    throw new Error('profileId is only valid when section=profiles');
  }

  if (section === 'routing') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = routingPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one routing field');
    }
    const nextRouting: RoutingPolicy = {
      ...config.routing,
      ...patch,
    };
    config.routing = nextRouting;
    return section;
  }

  if (section === 'contextManagement') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = contextManagementPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one contextManagement field');
    }
    const nextContext: ContextManagementPolicy = {
      ...config.contextManagement,
      ...patch,
    };
    config.contextManagement = nextContext;
    return section;
  }

  if (section === 'toolCompaction') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = toolCompactionPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one toolCompaction field');
    }
    const nextToolCompaction: ToolCompactionPolicy = {
      ...config.toolCompaction,
      ...patch,
    };
    config.toolCompaction = nextToolCompaction;
    return section;
  }

  if (section === 'apiEndpoints') {
    const patch = apiEndpointsPatchSchema.parse(parsePatch(input.patch));
    const secretUpdates = parseApiEndpointSecretUpdates(input.secretUpdates);

    if (Object.keys(patch).length === 0 && Object.keys(secretUpdates).length === 0) {
      throw new Error('No changes provided: patch and secretUpdates are both empty');
    }

    const nextApiEndpoints: ApiEndpointsConfig = {
      ...config.apiEndpoints,
      ...patch,
    };

    if (Object.prototype.hasOwnProperty.call(secretUpdates, 'endpointApiKey')) {
      nextApiEndpoints.endpointApiKey = applySecret(config.apiEndpoints.endpointApiKey, secretUpdates.endpointApiKey);
    }

    config.apiEndpoints = nextApiEndpoints;
    return section;
  }

  if (section === 'crossTabSync') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = crossTabSyncPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one crossTabSync field');
    }
    const nextCrossTabSync: CrossTabSyncPolicy = {
      ...config.crossTabSync,
      ...patch,
    };
    config.crossTabSync = nextCrossTabSync;
    return section;
  }

  if (section === 'uiSettings') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = uiSettingsPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one uiSettings field');
    }
    const nextUiSettings: UISettingsPolicy = {
      ...config.uiSettings,
      ...patch,
    };
    config.uiSettings = nextUiSettings;
    return section;
  }

  if (section === 'modelBehavior') {
    ensureNoSecretUpdates(input.secretUpdates, section);
    const patch = modelBehaviorPatchSchema.parse(parsePatch(input.patch));
    if (Object.keys(patch).length === 0) {
      throw new Error('patch must include at least one modelBehavior field');
    }
    const nextOverrides: ModelBehaviorPolicy['modelOverrides'] = {
      ...config.modelBehavior.modelOverrides,
    };
    if (patch.modelOverrides) {
      for (const [modelId, overridePatch] of Object.entries(patch.modelOverrides)) {
        const existingOverride = nextOverrides[modelId];
        nextOverrides[modelId] = {
          systemPrompts: overridePatch.systemPrompts ?? existingOverride?.systemPrompts ?? [],
          sampling: {
            ...(existingOverride?.sampling ?? {}),
            ...(overridePatch.sampling ?? {}),
          },
        };
      }
    }
    const nextModelBehavior: ModelBehaviorPolicy = {
      ...config.modelBehavior,
      ...patch,
      defaultSampling: {
        ...config.modelBehavior.defaultSampling,
        ...(patch.defaultSampling ?? {}),
      },
      modelOverrides: nextOverrides,
    };
    config.modelBehavior = nextModelBehavior;
    return section;
  }

  ensureNoSecretUpdates(input.secretUpdates, section);
  const patch = agentExecutionPatchSchema.parse(parsePatch(input.patch));
  if (Object.keys(patch).length === 0) {
    throw new Error('patch must include at least one agentExecution field');
  }
  const nextAgentExecution: AgentExecutionPolicy = {
    ...config.agentExecution,
    ...patch,
  };
  config.agentExecution = nextAgentExecution;
  return section;
}

export const settingsConfigTool = createTool({
  id: 'settings_config',
  description: 'Views sanitized app settings and applies strictly validated section edits with controlled secret updates.',
  inputSchema: settingsConfigInputSchema,
  execute: async (args) => {
    try {
      const input = settingsConfigInputSchema.parse(args);

      if (input.action === 'view') {
        const config = sanitizeConfig(await readConfig());
        return {
          ok: true,
          config: getSectionConfig(config, input.section),
        };
      }

      const current = await readConfig();
      if (input.expectedUpdatedAt && current.updatedAt !== input.expectedUpdatedAt) {
        return {
          ok: false,
          error: `expectedUpdatedAt mismatch: expected=${input.expectedUpdatedAt}, actual=${current.updatedAt ?? 'undefined'}`,
        };
      }

      const next = structuredClone(current);
      const appliedSection = applySectionEdit(next, input);

      assertProfileReferences(next);
      assertNoNormalizationChanges(next);

      const dryRun = Boolean(input.dryRun);
      if (dryRun) {
        const sanitized = sanitizeConfig(next);
        return {
          ok: true,
          config: getSectionConfig(sanitized, input.section),
          updatedAt: current.updatedAt,
          appliedSection,
          dryRun: true,
        };
      }

      await writeConfig(next);
      const persisted = await readConfig();
      const sanitized = sanitizeConfig(persisted);

      return {
        ok: true,
        config: getSectionConfig(sanitized, input.section),
        updatedAt: persisted.updatedAt,
        appliedSection,
        dryRun: false,
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return {
          ok: false,
          error: formatValidationError(err),
        };
      }

      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export const settingsConfigToolMetadata: BuiltinToolMetadata = {
  icon: '🎛️',
  description: 'Read sanitized settings and apply strict section edits (including controlled secret updates).',
  expectedDurationMs: 300,
  inputs: ['action (view|edit)', 'section?', 'profileOp?', 'profileId?', 'patch?', 'secretUpdates?', 'expectedUpdatedAt?', 'dryRun?'],
  outputs: ['ok', 'config', 'updatedAt?', 'appliedSection?', 'dryRun?', 'error?'],
  inputSchema: settingsConfigInputSchema,
};
