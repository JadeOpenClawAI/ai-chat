import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatThreadId, resolveCompatThreadId, resolveAuthenticatedResourceId } from '@/lib/mastra/keys';
import { resolveSemanticRecallTarget } from '@/lib/mastra/policy';
import { makeBaseConfig, makeProfile } from './helpers';

test('resolves chat and compat thread IDs from message history scope', () => {
  const sharedConfig = makeBaseConfig();
  assert.equal(resolveChatThreadId(sharedConfig, 'abc'), 'chat:shared');
  assert.equal(resolveCompatThreadId(sharedConfig, 'thread-1'), 'compat:shared');

  const perConversationConfig = makeBaseConfig({
    mastraMemory: {
      ...makeBaseConfig().mastraMemory,
      messageHistoryScope: 'per-conversation',
    },
  });
  assert.equal(resolveChatThreadId(perConversationConfig, 'abc'), 'conversation:abc');
  assert.equal(resolveCompatThreadId(perConversationConfig, 'thread-1'), 'thread-1');
});

test('authenticated resource ID is stable within the process', () => {
  assert.equal(resolveAuthenticatedResourceId(), resolveAuthenticatedResourceId());
});

test('semantic recall infer mode uses the active OpenAI profile when supported', () => {
  const config = makeBaseConfig({
    profiles: [
      makeProfile({
        id: 'openai:default',
        provider: 'openai',
        allowedModels: ['gpt-5.4'],
      }),
    ],
    mastraMemory: {
      ...makeBaseConfig().mastraMemory,
      semanticRecall: {
        enabled: true,
        scope: 'resource',
        topK: 4,
        contextBefore: 1,
        contextAfter: 1,
        threshold: 0.7,
        embedderMode: 'infer',
      },
    },
  });

  const status = resolveSemanticRecallTarget(config, config.profiles[0]!, 'summary');
  assert.equal(status.state, 'enabled');
  assert.equal(status.profileId, 'openai:default');
  assert.equal(status.modelId, 'text-embedding-3-small');
});

test('semantic recall infer mode falls back from unsupported providers', () => {
  const config = makeBaseConfig({
    profiles: [
      makeProfile({
        id: 'anthropic:default',
        provider: 'anthropic',
        allowedModels: ['claude-sonnet-4-5'],
      }),
      makeProfile({
        id: 'openai:default',
        provider: 'openai',
        allowedModels: ['gpt-5.4'],
      }),
    ],
    mastraMemory: {
      ...makeBaseConfig().mastraMemory,
      semanticRecall: {
        enabled: true,
        scope: 'resource',
        topK: 4,
        contextBefore: 1,
        contextAfter: 1,
        threshold: 0.7,
        embedderMode: 'infer',
      },
    },
  });

  const status = resolveSemanticRecallTarget(config, config.profiles[0]!, 'summary');
  assert.equal(status.state, 'enabled');
  assert.equal(status.profileId, 'openai:default');
  assert.equal(status.modelId, 'text-embedding-3-small');
});

test('semantic recall direct mode requires an explicit embedding-capable profile', () => {
  const config = makeBaseConfig({
    mastraMemory: {
      ...makeBaseConfig().mastraMemory,
      semanticRecall: {
        enabled: true,
        scope: 'resource',
        topK: 4,
        contextBefore: 1,
        contextAfter: 1,
        threshold: 0.7,
        embedderMode: 'direct',
      },
    },
  });

  const status = resolveSemanticRecallTarget(config, config.profiles[0]!, 'summary');
  assert.equal(status.state, 'skipped');
  assert.match(status.reason, /explicit profile and model/i);
});

test('semantic recall reports when no embedding-capable profile is available', () => {
  const config = makeBaseConfig({
    profiles: [
      makeProfile({
        id: 'anthropic:default',
        provider: 'anthropic',
        allowedModels: ['claude-sonnet-4-5'],
      }),
    ],
    mastraMemory: {
      ...makeBaseConfig().mastraMemory,
      semanticRecall: {
        enabled: true,
        scope: 'resource',
        topK: 4,
        contextBefore: 1,
        contextAfter: 1,
        threshold: 0.7,
        embedderMode: 'infer',
      },
    },
  });

  const status = resolveSemanticRecallTarget(config, config.profiles[0]!, 'summary');
  assert.equal(status.state, 'skipped');
  assert.match(status.reason, /no enabled embedding-capable profile/i);
});
