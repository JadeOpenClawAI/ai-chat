import type { AppConfig, ProfileConfig } from '@/lib/config/store';

export function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'anthropic:default',
    provider: 'anthropic',
    displayName: 'Anthropic Default',
    enabled: true,
    allowedModels: ['claude-sonnet-4-5'],
    systemPrompts: [],
    ...overrides,
  };
}

export function makeBaseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const profiles = overrides.profiles ?? [makeProfile()];
  return {
    profiles,
    routing: overrides.routing ?? {
      activityProfiles: [
        {
          id: 'general',
          label: 'General',
          modelPriority: [
            {
              profileId: profiles[0]!.id,
              modelId: profiles[0]!.allowedModels[0]!,
            },
          ],
        },
      ],
      defaultActivityProfileId: 'general',
      maxAttempts: 3,
    },
    conversations: overrides.conversations ?? {},
    contextManagement: overrides.contextManagement ?? {
      mode: 'summary',
      maxContextTokens: 150000,
      compactionThreshold: 0.75,
      targetContextRatio: 0.1,
      keepRecentMessages: 10,
      minRecentMessages: 4,
      runningSummaryThreshold: 0.35,
      summaryMaxTokens: 1200,
      transcriptMaxChars: 120000,
    },
    toolCompaction: overrides.toolCompaction ?? {
      mode: 'summary',
      thresholdTokens: 2000,
      summaryMaxTokens: 1000,
      summaryInputMaxChars: 50000,
      truncateMaxChars: 8000,
    },
    apiEndpoints: overrides.apiEndpoints ?? {
      enableOpenAICompat: false,
      enableAnthropicCompat: false,
    },
    crossTabSync: overrides.crossTabSync ?? {
      enabled: true,
      syncMessages: true,
      syncConversationSelection: true,
      syncSidebarOpen: true,
      syncSubAgentPanel: true,
      syncHistory: true,
      syncStreamingState: true,
      syncStopRequests: true,
      syncDraftInput: true,
    },
    uiSettings: overrides.uiSettings ?? {
      aiConversationTitles: true,
      aiTitleUpdateEveryMessages: 4,
      aiTitleEagerUpdatesForFirstMessages: 5,
    },
    mastraMemory: overrides.mastraMemory ?? {
      messageHistoryScope: 'all-conversations',
      workingMemory: {
        enabled: true,
        scope: 'resource',
      },
      semanticRecall: {
        enabled: false,
        scope: 'resource',
        topK: 4,
        contextBefore: 1,
        contextAfter: 1,
        threshold: 0.7,
        embedderMode: 'infer',
      },
      observationalMemory: {
        enabled: false,
        scope: 'thread',
        shareTokenBudget: false,
        observationMessageTokens: 20000,
        observationMaxTokensPerBatch: 8000,
        reflectionObservationTokens: 90000,
      },
    },
    modelBehavior: overrides.modelBehavior ?? {
      globalSystemPrompts: [],
      defaultSampling: {},
      modelOverrides: {},
    },
    agentExecution: overrides.agentExecution ?? {
      maxSteps: 10,
      maxSubAgentSteps: 10,
    },
    updatedAt: overrides.updatedAt,
  };
}
