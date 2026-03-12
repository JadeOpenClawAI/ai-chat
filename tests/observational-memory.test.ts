import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeCompact } from '@/lib/ai/context-manager';

test('observational-memory mode skips the custom compaction pipeline', async () => {
  const messages = [
    { role: 'user' as const, content: 'alpha '.repeat(8000) },
    { role: 'assistant' as const, content: 'beta '.repeat(8000) },
    { role: 'user' as const, content: 'gamma '.repeat(8000) },
  ];

  const result = await maybeCompact(
    messages,
    {
      model: {} as never,
      provider: 'openai',
      modelId: 'gpt-5.4',
    },
    undefined,
    'gpt-5.4',
    {
      compactionMode: 'observational-memory',
      maxContextTokens: 1000,
      compactionThreshold: 0.1,
      targetContextRatio: 0.05,
      keepRecentMessages: 1,
      minRecentMessages: 1,
      runningSummaryThreshold: 0.05,
      summaryMaxTokens: 200,
      transcriptMaxChars: 4000,
    },
  );

  assert.equal(result.wasCompacted, false);
  assert.equal(result.compactionMode, 'observational-memory');
  assert.deepEqual(result.messages, messages);
});
