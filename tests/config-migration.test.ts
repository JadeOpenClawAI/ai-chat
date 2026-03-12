import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '@/lib/config/store';
import { makeBaseConfig } from './helpers';

test('migrates legacy uiSettings.mastraMemoryScope into mastraMemory.messageHistoryScope', () => {
  const legacyConfig = {
    ...makeBaseConfig(),
    mastraMemory: undefined,
    uiSettings: {
      aiConversationTitles: true,
      aiTitleUpdateEveryMessages: 4,
      aiTitleEagerUpdatesForFirstMessages: 5,
      mastraMemoryScope: 'per-conversation',
    },
  };

  const normalized = normalizeConfig(legacyConfig as never);

  assert.equal(normalized.mastraMemory.messageHistoryScope, 'per-conversation');
  assert.equal(normalized.uiSettings.aiConversationTitles, true);
  assert.equal('mastraMemoryScope' in normalized.uiSettings, false);
});

test('accepts observational-memory as a valid context compaction mode', () => {
  const normalized = normalizeConfig(makeBaseConfig({
    contextManagement: {
      ...makeBaseConfig().contextManagement,
      mode: 'observational-memory',
    },
  }));

  assert.equal(normalized.contextManagement.mode, 'observational-memory');
});
