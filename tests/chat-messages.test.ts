import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyToolResult } from '@/lib/chat-messages';

test('stringifyToolResult returns a fallback string for undefined output', () => {
  assert.equal(stringifyToolResult(undefined), '(No output)');
});

test('stringifyToolResult falls back when JSON.stringify returns undefined', () => {
  const fn = () => 'noop';
  assert.equal(stringifyToolResult(fn), String(fn));
});
