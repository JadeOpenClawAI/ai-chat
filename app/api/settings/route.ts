/* eslint-disable max-len */
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
  type ApiEndpointsConfig,
  type CrossTabSyncPolicy,
  type UISettingsPolicy,
  type ModelBehaviorPolicy,
  type AgentExecutionPolicy,
} from '@/lib/config/store';
import { getModelOptions } from '@/lib/ai/providers';
import { getMastraMemory } from '@/lib/mastra/memory';

interface SettingsRequest {
  action?: 'profile-create' | 'profile-update' | 'profile-delete' | 'routing-update' | 'context-management-update' | 'tool-compaction-update' | 'api-endpoints-update' | 'cross-tab-sync-update' | 'ui-settings-update' | 'model-behavior-update' | 'agent-execution-update' | 'memory-wipe-all';
  profile?: ProfileConfig;
  profileId?: string;
  originalProfileId?: string;
  routing?: RoutingPolicy;
  contextManagement?: Partial<ContextManagementPolicy>;
  toolCompaction?: Partial<ToolCompactionPolicy>;
  apiEndpoints?: Partial<ApiEndpointsConfig>;
  crossTabSync?: Partial<CrossTabSyncPolicy>;
  uiSettings?: Partial<UISettingsPolicy>;
  modelBehavior?: Partial<ModelBehaviorPolicy>;
  agentExecution?: Partial<AgentExecutionPolicy>;
}

function firstFallbackTarget(config: { profiles: ProfileConfig[] }): { profileId: string; modelId: string } | null {
  const firstProfile = config.profiles[0];
  if (!firstProfile) {
    return null;
  }
  return {
    profileId: firstProfile.id,
    modelId: firstProfile.allowedModels[0] ?? 'claude-sonnet-4-5',
  };
}

function rewriteRoutingProfileRefs(
  routing: RoutingPolicy,
  fromProfileId: string,
  toProfileId: string,
): RoutingPolicy {
  return {
    ...routing,
    activityProfiles: routing.activityProfiles.map((activity) => ({
      ...activity,
      modelPriority: activity.modelPriority.map((target) => (
        target.profileId === fromProfileId ? { ...target, profileId: toProfileId } : target
      )),
    })),
  };
}

function removeProfileFromRouting(
  routing: RoutingPolicy,
  deletedProfileId: string,
  fallbackTarget: { profileId: string; modelId: string } | null,
): RoutingPolicy {
  return {
    ...routing,
    activityProfiles: routing.activityProfiles.map((activity) => {
      const filtered = activity.modelPriority.filter((target) => target.profileId !== deletedProfileId);
      return {
        ...activity,
        modelPriority: filtered.length > 0 ? filtered : (fallbackTarget ? [fallbackTarget] : []),
      };
    }),
  };
}

export async function GET() {
  const config = await readConfig();
  return Response.json({
    config: sanitizeConfig(config),
    models: getModelOptions(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as SettingsRequest;
  const config = await readConfig();

  if (!body.action) {
    return Response.json({ ok: true, config: sanitizeConfig(config), models: getModelOptions() });
  }

  if (body.action === 'profile-create') {
    if (!body.profile) {
      return Response.json({ ok: false, error: 'Missing profile' }, { status: 400 });
    }
    validateProfile(body.profile);
    if (getProfileById(config, body.profile.id)) {
      return Response.json({ ok: false, error: 'Profile already exists' }, { status: 400 });
    }
    config.profiles.push(body.profile);
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'profile-update') {
    if (!body.profile) {
      return Response.json({ ok: false, error: 'Missing profile' }, { status: 400 });
    }
    validateProfile(body.profile);

    const lookupId = body.originalProfileId ?? body.profile.id;
    const idx = config.profiles.findIndex((p) => p.id === lookupId);
    if (idx === -1) {
      return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 });
    }

    // Prevent id collision when renaming.
    if (body.profile.id !== lookupId && config.profiles.some((p) => p.id === body.profile!.id)) {
      return Response.json({ ok: false, error: 'Profile ID already exists' }, { status: 400 });
    }

    const previous = config.profiles[idx];
    if (previous?.requiredFirstSystemPrompt && body.profile.requiredFirstSystemPrompt !== previous.requiredFirstSystemPrompt) {
      return Response.json({ ok: false, error: 'requiredFirstSystemPrompt is immutable once set' }, { status: 400 });
    }
    config.profiles[idx] = mergeProfileSecrets(previous, body.profile);

    // Rewrite routing + conversation refs if profile id changed.
    if (body.profile.id !== lookupId) {
      config.routing = rewriteRoutingProfileRefs(config.routing, lookupId, body.profile.id);
      for (const key of Object.keys(config.conversations)) {
        const state = config.conversations[key];
        if (state?.activeProfileId === lookupId) {
          config.conversations[key] = { ...state, activeProfileId: body.profile.id };
        }
      }
    }

    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'profile-delete') {
    if (!body.profileId) {
      return Response.json({ ok: false, error: 'Missing profileId' }, { status: 400 });
    }
    config.profiles = config.profiles.filter((p) => p.id !== body.profileId);
    const fallbackTarget = firstFallbackTarget(config);
    config.routing = removeProfileFromRouting(config.routing, body.profileId, fallbackTarget);
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'routing-update') {
    if (!body.routing) {
      return Response.json({ ok: false, error: 'Missing routing' }, { status: 400 });
    }
    config.routing = body.routing;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'context-management-update') {
    if (!body.contextManagement) {
      return Response.json({ ok: false, error: 'Missing contextManagement' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      contextManagement: {
        ...config.contextManagement,
        ...body.contextManagement,
      },
    });
    config.contextManagement = normalized.contextManagement;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'tool-compaction-update') {
    if (!body.toolCompaction) {
      return Response.json({ ok: false, error: 'Missing toolCompaction' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      toolCompaction: {
        ...config.toolCompaction,
        ...body.toolCompaction,
      },
    });
    config.toolCompaction = normalized.toolCompaction;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'api-endpoints-update') {
    if (!body.apiEndpoints) {
      return Response.json({ ok: false, error: 'Missing apiEndpoints' }, { status: 400 });
    }
    // Preserve existing endpointApiKey if incoming value is the secret mask
    const incomingKey = body.apiEndpoints.endpointApiKey;
    const resolvedKey = incomingKey === '***' ? config.apiEndpoints?.endpointApiKey : incomingKey;
    const normalized = normalizeConfig({
      ...config,
      apiEndpoints: {
        ...config.apiEndpoints,
        ...body.apiEndpoints,
        endpointApiKey: resolvedKey,
      },
    });
    config.apiEndpoints = normalized.apiEndpoints;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'cross-tab-sync-update') {
    if (!body.crossTabSync) {
      return Response.json({ ok: false, error: 'Missing crossTabSync' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      crossTabSync: {
        ...config.crossTabSync,
        ...body.crossTabSync,
      },
    });
    config.crossTabSync = normalized.crossTabSync;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'ui-settings-update') {
    if (!body.uiSettings) {
      return Response.json({ ok: false, error: 'Missing uiSettings' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      uiSettings: {
        ...config.uiSettings,
        ...body.uiSettings,
      },
    });
    config.uiSettings = normalized.uiSettings;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'memory-wipe-all') {
    const memory = await getMastraMemory();
    const listed = await memory.listThreads({ perPage: false });
    await Promise.all(listed.threads.map(async (thread) => {
      await memory.deleteThread(thread.id);
    }));
    return Response.json({
      ok: true,
      wipedCount: listed.threads.length,
      config: sanitizeConfig(config),
    });
  }

  if (body.action === 'model-behavior-update') {
    if (!body.modelBehavior) {
      return Response.json({ ok: false, error: 'Missing modelBehavior' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      modelBehavior: {
        ...config.modelBehavior,
        ...body.modelBehavior,
        defaultSampling: {
          ...config.modelBehavior.defaultSampling,
          ...(body.modelBehavior.defaultSampling ?? {}),
        },
        modelOverrides: body.modelBehavior.modelOverrides ?? config.modelBehavior.modelOverrides,
      },
    });
    config.modelBehavior = normalized.modelBehavior;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  if (body.action === 'agent-execution-update') {
    if (!body.agentExecution) {
      return Response.json({ ok: false, error: 'Missing agentExecution' }, { status: 400 });
    }
    const normalized = normalizeConfig({
      ...config,
      agentExecution: {
        ...config.agentExecution,
        ...body.agentExecution,
      },
    });
    config.agentExecution = normalized.agentExecution;
    await writeConfig(config);
    return Response.json({ ok: true, config: sanitizeConfig(config) });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
