import {
  getDefaultEmbeddingModelForProvider,
  getEmbeddingModelForProfile,
  getLanguageModelForProfile,
  isEmbeddingCapableProvider,
} from '@/lib/ai/providers';
import {
  getProfileById,
  type AppConfig,
  type ProfileConfig,
} from '@/lib/config/store';
import type { ContextCompactionMode, LLMProvider } from '@/lib/types';
import { resolveAuthenticatedResourceId } from './keys';
import { buildPrimaryMemoryCall, type MastraCallMemory } from './runtime';
import { WorkingMemoryProfileSchema } from './working-memory';

const EMBEDDER_FALLBACK_PROVIDER_ORDER: LLMProvider[] = [
  'openai',
  'google-antigravity',
  'google-gemini-cli',
];

export interface SemanticRecallStatus {
  state: 'disabled' | 'enabled' | 'skipped';
  reason: string;
  profileId?: string;
  modelId?: string;
}

export function resolveSemanticRecallTarget(
  config: AppConfig,
  activeProfile: ProfileConfig,
  compactionMode: ContextCompactionMode,
): SemanticRecallStatus {
  const policy = config.mastraMemory.semanticRecall;
  if (!policy.enabled) {
    return {
      state: 'disabled',
      reason: 'Semantic recall disabled in settings',
    };
  }

  if (compactionMode === 'observational-memory') {
    return {
      state: 'disabled',
      reason: 'Semantic recall disabled while observational memory mode is active',
    };
  }

  if (policy.embedderMode === 'direct') {
    if (!policy.directProfileId || !policy.directModelId) {
      return {
        state: 'skipped',
        reason: 'Direct semantic recall requires an explicit profile and model',
      };
    }

    const directProfile = getProfileById(config, policy.directProfileId);
    if (!directProfile?.enabled) {
      return {
        state: 'skipped',
        reason: 'Direct semantic recall profile is missing or disabled',
      };
    }
    if (!isEmbeddingCapableProvider(directProfile.provider)) {
      return {
        state: 'skipped',
        reason: `Provider ${directProfile.provider} does not support embeddings`,
      };
    }

    return {
      state: 'enabled',
      reason: 'Using direct semantic recall embedder',
      profileId: directProfile.id,
      modelId: policy.directModelId,
    };
  }

  const profileToUse = isEmbeddingCapableProvider(activeProfile.provider)
    ? activeProfile
    : findFirstEnabledEmbeddingProfile(config);

  if (!profileToUse) {
    return {
      state: 'skipped',
      reason: 'No enabled embedding-capable profile is available',
    };
  }

  const defaultModelId = getDefaultEmbeddingModelForProvider(profileToUse.provider);
  if (!defaultModelId) {
    return {
      state: 'skipped',
      reason: `No default embedding model is configured for provider ${profileToUse.provider}`,
    };
  }

  return {
    state: 'enabled',
    reason: profileToUse.id === activeProfile.id
      ? 'Inferred semantic recall embedder from active route'
      : `Fell back to ${profileToUse.id} for semantic recall embeddings`,
    profileId: profileToUse.id,
    modelId: defaultModelId,
  };
}

function buildWorkingMemoryOption(config: AppConfig): MastraCallMemory['workingMemory'] | undefined {
  if (!config.mastraMemory.workingMemory.enabled) {
    return undefined;
  }

  return {
    enabled: true,
    scope: config.mastraMemory.workingMemory.scope,
    schema: WorkingMemoryProfileSchema,
  };
}

function findFirstEnabledEmbeddingProfile(config: AppConfig): ProfileConfig | null {
  for (const provider of EMBEDDER_FALLBACK_PROVIDER_ORDER) {
    const profile = config.profiles.find((candidate) => candidate.enabled && candidate.provider === provider);
    if (profile) {
      return profile;
    }
  }
  return null;
}

async function resolveSemanticRecall(
  config: AppConfig,
  activeProfile: ProfileConfig,
  compactionMode: ContextCompactionMode,
): Promise<{
  semanticRecall?: MastraCallMemory['semanticRecall'];
  embedder?: MastraCallMemory['embedder'];
  status: SemanticRecallStatus;
}> {
  const policy = config.mastraMemory.semanticRecall;
  const target = resolveSemanticRecallTarget(config, activeProfile, compactionMode);
  if (target.state !== 'enabled' || !target.profileId || !target.modelId) {
    return {
      status: target,
    };
  }

  const resolved = await getEmbeddingModelForProfile(target.profileId, target.modelId);
  return {
    semanticRecall: {
      topK: policy.topK,
      messageRange: {
        before: policy.contextBefore,
        after: policy.contextAfter,
      },
      scope: policy.scope,
      threshold: policy.threshold,
    },
    embedder: {
      key: `${resolved.profile.id}:${resolved.modelId}`,
      model: resolved.model,
      provider: resolved.profile.provider,
      modelId: resolved.modelId,
    },
    status: {
      state: target.state,
      reason: target.reason,
      profileId: resolved.profile.id,
      modelId: resolved.modelId,
    },
  };
}

async function resolveObservationalMemory(
  config: AppConfig,
  compactionMode: ContextCompactionMode,
  activeProfileId: string,
  activeModelId: string,
): Promise<MastraCallMemory['observationalMemory'] | undefined> {
  const policy = config.mastraMemory.observationalMemory;
  if (compactionMode !== 'observational-memory' || !policy.enabled) {
    return undefined;
  }

  const profileId = policy.modelProfileId ?? activeProfileId;
  const modelId = policy.modelId ?? activeModelId;
  const resolved = await getLanguageModelForProfile(profileId, modelId);
  return {
    enabled: true,
    scope: policy.scope,
    model: resolved.model as never,
    shareTokenBudget: policy.shareTokenBudget,
    observation: {
      messageTokens: policy.observationMessageTokens,
      maxTokensPerBatch: policy.observationMaxTokensPerBatch,
    },
    reflection: {
      observationTokens: policy.reflectionObservationTokens,
    },
  };
}

export async function buildScopedPrimaryMemoryCall(params: {
  config: AppConfig;
  threadId: string;
  activeProfileId: string;
  activeModelId: string;
  compactionMode: ContextCompactionMode;
}): Promise<{
  memory: MastraCallMemory;
  semanticRecallStatus: SemanticRecallStatus;
}> {
  const {
    config,
    threadId,
    activeProfileId,
    activeModelId,
    compactionMode,
  } = params;

  const activeProfile = getProfileById(config, activeProfileId);
  if (!activeProfile) {
    throw new Error(`Active profile not found: ${activeProfileId}`);
  }

  const semanticRecallResolution = await resolveSemanticRecall(config, activeProfile, compactionMode);
  const observationalMemory = await resolveObservationalMemory(
    config,
    compactionMode,
    activeProfileId,
    activeModelId,
  );

  return {
    memory: buildPrimaryMemoryCall({
      threadId,
      resourceId: resolveAuthenticatedResourceId(),
      workingMemory: buildWorkingMemoryOption(config),
      ...(semanticRecallResolution.semanticRecall ? { semanticRecall: semanticRecallResolution.semanticRecall } : {}),
      ...(semanticRecallResolution.embedder ? { embedder: semanticRecallResolution.embedder } : {}),
      ...(observationalMemory ? { observationalMemory } : {}),
    }),
    semanticRecallStatus: semanticRecallResolution.status,
  };
}
