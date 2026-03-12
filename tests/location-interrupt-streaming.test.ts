import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatEventStream, type ChatStreamEvent } from '@/lib/chat-protocol';
import { createChatEventStreamFromMastra } from '@/lib/mastra/streaming';
import { LocationRequestInterruptError } from '@/lib/location/interrupt';
import type { StreamAnnotation } from '@/lib/types';

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<ChatStreamEvent[]> {
  const reader = parseChatEventStream(stream).getReader();
  const events: ChatStreamEvent[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return events;
      }
      if (value) {
        events.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test('location interrupts suppress a follow-on stream error while still delivering the annotation', async () => {
  const annotation: Extract<StreamAnnotation, { type: 'location-request' }> = {
    type: 'location-request',
    requestId: 'req-location-1',
    nonce: 'nonce-location-1',
    state: 'state-location-1',
    expiresAt: '2026-03-12T10:05:00.000Z',
    conversationId: 'conversation-1',
    reason: 'Need a fresh browser fix.',
    resumeLabel: 'Share location and retry',
  };

  const stream = createChatEventStreamFromMastra({
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error('Request aborted');
          },
        };
      },
    },
    annotationStream: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield annotation;
      },
    },
    shouldSuppressError: () => true,
  });

  const events = await collectEvents(stream);

  assert.deepEqual(events.map((event) => event.type), ['annotation', 'finish']);
  assert.deepEqual((events[0] as Extract<ChatStreamEvent, { type: 'annotation' }>).data, annotation);
});

test('location interrupt errors emit a single annotation and no terminal error event', async () => {
  const annotation: Extract<StreamAnnotation, { type: 'location-request' }> = {
    type: 'location-request',
    requestId: 'req-location-2',
    nonce: 'nonce-location-2',
    state: 'state-location-2',
    expiresAt: '2026-03-12T10:05:00.000Z',
    conversationId: 'conversation-2',
    reason: 'Need local timezone from the browser.',
    resumeLabel: 'Share location and retry',
  };

  const stream = createChatEventStreamFromMastra({
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new LocationRequestInterruptError('Browser location requested', annotation);
          },
        };
      },
    },
  });

  const events = await collectEvents(stream);

  assert.deepEqual(events.map((event) => event.type), ['annotation', 'finish']);
  assert.deepEqual((events[0] as Extract<ChatStreamEvent, { type: 'annotation' }>).data, annotation);
});
