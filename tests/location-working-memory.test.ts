import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearStoredLocation,
  LocationPayloadSchema,
  mergeStoredLocation,
  parseWorkingMemoryProfile,
  readStoredLocation,
  serializeWorkingMemoryProfile,
} from '@/lib/mastra/working-memory';

test('location payload schema validates exact coordinates and metadata', () => {
  const parsed = LocationPayloadSchema.safeParse({
    conversationId: 'conversation-1',
    latitude: 41.8781,
    longitude: -87.6298,
    accuracyMeters: 12,
    timezone: 'America/Chicago',
    locale: 'en-US',
    capturedAt: '2026-03-12T10:00:00.000Z',
    source: 'browser-geolocation-manual',
  });

  assert.equal(parsed.success, true);
});

test('stored location overwrites location fields and preserves the rest of working memory', () => {
  const profile = parseWorkingMemoryProfile(JSON.stringify({
    profileSummary: 'Prefers concise answers.',
    preferences: ['concise'],
  }));
  const merged = mergeStoredLocation(profile, {
    latitude: 41.8781,
    longitude: -87.6298,
    accuracyMeters: 12,
    timezone: 'America/Chicago',
    locale: 'en-US',
    capturedAt: '2026-03-12T10:00:00.000Z',
    source: 'browser-geolocation-manual',
  });

  assert.equal(merged.profileSummary, 'Prefers concise answers.');
  assert.deepEqual(readStoredLocation(merged), {
    latitude: 41.8781,
    longitude: -87.6298,
    accuracyMeters: 12,
    timezone: 'America/Chicago',
    locale: 'en-US',
    capturedAt: '2026-03-12T10:00:00.000Z',
    source: 'browser-geolocation-manual',
  });
});

test('clearing stored location removes only the location fields', () => {
  const profile = parseWorkingMemoryProfile(serializeWorkingMemoryProfile({
    profileSummary: 'Prefers concise answers.',
    latitude: 41.8781,
    longitude: -87.6298,
    accuracyMeters: 12,
    timezone: 'America/Chicago',
    locale: 'en-US',
    capturedAt: '2026-03-12T10:00:00.000Z',
    source: 'browser-geolocation-manual',
  }));

  const cleared = clearStoredLocation(profile);

  assert.equal(cleared.profileSummary, 'Prefers concise answers.');
  assert.equal(readStoredLocation(cleared), null);
});
