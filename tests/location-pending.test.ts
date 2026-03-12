import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPendingLocationRequestsForTests,
  createLocationRequestSession,
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

test('location request sessions reuse one pending prompt across concurrent callers', async () => {
  const annotations: Array<{ type: string; requestId?: string }> = [];
  const session = createLocationRequestSession({
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-4',
    emitAnnotation: (annotation) => {
      annotations.push({
        type: annotation.type,
        ...(annotation.type === 'location-request'
          ? { requestId: annotation.requestId }
          : {}),
      });
    },
  });

  const first = session.request('Need exact location.');
  const second = session.request('Need timezone too.');

  assert.equal(first.wasCreated, true);
  assert.equal(second.wasCreated, false);
  assert.equal(first.annotation?.requestId, second.annotation?.requestId);
  assert.equal(annotations.filter((annotation) => annotation.type === 'location-request').length, 1);

  resolvePendingLocationRequest({
    requestId: first.annotation?.requestId ?? '',
    nonce: first.annotation?.nonce ?? '',
    state: first.annotation?.state ?? '',
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-4',
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

  const [firstResolution, secondResolution] = await Promise.all([
    first.waitForResolution(),
    second.waitForResolution(),
  ]);

  assert.equal(firstResolution.status, 'saved');
  assert.equal(secondResolution.status, 'saved');
  assert.equal(firstResolution.requestId, secondResolution.requestId);
  clearPendingLocationRequestsForTests();
});

test('location request sessions reuse the resolved result later in the same turn', async () => {
  const session = createLocationRequestSession({
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-5',
  });

  const initial = session.request('Need exact location.');
  resolvePendingLocationRequest({
    requestId: initial.annotation?.requestId ?? '',
    nonce: initial.annotation?.nonce ?? '',
    state: initial.annotation?.state ?? '',
    resourceId: 'authenticated:test-user',
    conversationId: 'conversation-5',
    status: 'cancelled',
    message: 'User declined.',
  });

  const initialResolution = await initial.waitForResolution();
  const followUp = session.request('Need exact location again.');
  const followUpResolution = await followUp.waitForResolution();

  assert.equal(followUp.wasCreated, false);
  assert.equal(initialResolution.status, 'cancelled');
  assert.equal(followUpResolution.status, 'cancelled');
  assert.equal(initialResolution.requestId, followUpResolution.requestId);
  clearPendingLocationRequestsForTests();
});
