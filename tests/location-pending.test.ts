import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPendingLocationRequestsForTests,
  createPendingLocationRequest,
  hasPendingLocationRequest,
  resolvePendingLocationRequest,
  validatePendingLocationRequest,
} from '@/lib/location/pending';

test('pending location requests require matching nonce and state before resolving', async () => {
  const pending = createPendingLocationRequest({
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-1',
    reason: 'Need exact timezone.',
  });

  assert.equal(hasPendingLocationRequest(pending.annotation.requestId), true);
  assert.throws(() => {
    resolvePendingLocationRequest({
      requestId: pending.annotation.requestId,
      nonce: 'wrong-nonce',
      state: pending.annotation.state,
      resourceId: 'authenticated:test-user',
      conversationId: 'conversation-1',
      status: 'cancelled',
      message: 'Wrong nonce should fail.',
    });
  }, /nonce/i);

  const resolved = resolvePendingLocationRequest({
    requestId: pending.annotation.requestId,
    nonce: pending.annotation.nonce,
    state: pending.annotation.state,
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-1',
    status: 'saved',
    message: 'Saved.',
    location: {
      latitude: 41.8781,
      longitude: -87.6298,
      accuracyMeters: 12,
      timezone: 'America/Chicago',
      locale: 'en-US',
      capturedAt: '2026-03-12T10:00:00.000Z',
      source: 'browser-geolocation-assistant',
    },
  });

  assert.equal(resolved.status, 'saved');
  assert.equal((await pending.waitForResolution()).status, 'saved');
  assert.equal(hasPendingLocationRequest(pending.annotation.requestId), false);
  clearPendingLocationRequestsForTests();
});

test('pending location requests validate resource and conversation before persistence', () => {
  const pending = createPendingLocationRequest({
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-3',
    reason: 'Need exact location.',
  });

  assert.throws(() => {
    validatePendingLocationRequest({
      requestId: pending.annotation.requestId,
      nonce: pending.annotation.nonce,
      state: pending.annotation.state,
      resourceId: 'authenticated:other-user',
      conversationId: 'conversation-3',
    });
  }, /resource/i);

  assert.throws(() => {
    validatePendingLocationRequest({
      requestId: pending.annotation.requestId,
      nonce: pending.annotation.nonce,
      state: pending.annotation.state,
      resourceId: 'authenticated:test-user',
      conversationId: 'conversation-mismatch',
    });
  }, /conversation/i);

  validatePendingLocationRequest({
    requestId: pending.annotation.requestId,
    nonce: pending.annotation.nonce,
    state: pending.annotation.state,
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-3',
  });

  clearPendingLocationRequestsForTests();
});

test('pending location requests time out and emit a timed-out status annotation', async () => {
  const annotations: Array<{ type: string; status?: string }> = [];
  const pending = createPendingLocationRequest({
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-2',
    emitAnnotation: (annotation) => {
      annotations.push({
        type: annotation.type,
        ...(annotation.type === 'location-status'
          ? { status: annotation.status }
          : {}),
      });
    },
    timeoutMs: 10,
  });

  const resolved = await pending.waitForResolution();

  assert.equal(resolved.status, 'timed-out');
  assert.equal(annotations.some((annotation) => annotation.type === 'location-status' && annotation.status === 'timed-out'), true);
  assert.equal(hasPendingLocationRequest(pending.annotation.requestId), false);
  clearPendingLocationRequestsForTests();
});
