import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyErrorDetails } from '@/lib/errors';

test('stringifyErrorDetails preserves error stack, cause, and custom fields', () => {
  const inner = new Error('inner failure');
  const outer = new Error('outer failure', { cause: inner });
  Object.assign(outer, {
    code: 'E_SUB_AGENT',
    details: {
      tool: 'request_users_location',
      status: 'error',
    },
  });

  const serialized = stringifyErrorDetails(outer);

  assert.match(serialized, /outer failure/);
  assert.match(serialized, /inner failure/);
  assert.match(serialized, /E_SUB_AGENT/);
  assert.match(serialized, /request_users_location/);
  assert.match(serialized, /stack/);
});

test('stringifyErrorDetails handles circular values', () => {
  const payload: Record<string, unknown> = { ok: false };
  payload.self = payload;

  const serialized = stringifyErrorDetails(payload);

  assert.match(serialized, /Circular/);
});
