import { z } from 'zod/v3';
import { readConfig } from '@/lib/config/store';
import { resolvePendingLocationRequest, validatePendingLocationRequest } from '@/lib/location/pending';
import { getMastraMemory } from '@/lib/mastra/memory';
import { resolveAuthenticatedResourceId, resolveChatThreadId, SHARED_CHAT_THREAD_ID } from '@/lib/mastra/keys';
import {
  clearStoredLocation,
  LocationDeletePayloadSchema,
  LocationPayloadSchema,
  mergeStoredLocation,
  parseWorkingMemoryProfile,
  readStoredLocation,
  serializeWorkingMemoryProfile,
} from '@/lib/mastra/working-memory';

const STALE_LOCATION_MS = 30 * 60 * 1000;

const AssistantLocationRequestSchema = z.object({
  requestId: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  state: z.string().trim().min(1),
  status: z.enum(['saved', 'cancelled', 'denied', 'error']),
  message: z.string().trim().min(1).optional(),
});

const LocationSaveRequestSchema = LocationPayloadSchema.extend({
  assistantRequest: AssistantLocationRequestSchema.optional(),
});

const AssistantLocationResolutionSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  assistantRequest: AssistantLocationRequestSchema,
});

function defaultAssistantLocationMessage(status: 'saved' | 'cancelled' | 'denied' | 'error'): string {
  switch (status) {
    case 'saved':
      return 'Browser location saved to working memory.';
    case 'cancelled':
      return 'User declined the browser location prompt.';
    case 'denied':
      return 'Browser location permission was denied.';
    case 'error':
      return 'Browser location request failed.';
    default:
      return 'Location request resolved.';
  }
}

function isStaleLocation(capturedAt: string | undefined): boolean {
  if (!capturedAt) {
    return false;
  }
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) {
    return false;
  }
  return (Date.now() - capturedAtMs) > STALE_LOCATION_MS;
}

async function resolveLocationMemoryContext(conversationId: string | undefined) {
  const config = await readConfig();
  if (!config.mastraMemory.workingMemory.enabled) {
    throw new Error('Working memory must be enabled before location can be stored.');
  }

  const resourceId = resolveAuthenticatedResourceId();
  const threadId = conversationId?.trim()
    ? resolveChatThreadId(config, conversationId)
    : config.mastraMemory.workingMemory.scope === 'resource'
      ? SHARED_CHAT_THREAD_ID
      : resolveChatThreadId(config, conversationId);
  const memoryConfig = {
    workingMemory: {
      enabled: true as const,
      scope: config.mastraMemory.workingMemory.scope,
    },
  };

  return {
    config,
    threadId,
    resourceId,
    memoryConfig,
  };
}

async function ensureThreadScopedWorkingMemoryThread(
  memory: Awaited<ReturnType<typeof getMastraMemory>>,
  threadId: string,
  resourceId: string,
  memoryConfig: { workingMemory: { enabled: true; scope: 'resource' | 'thread' } },
) {
  if (memoryConfig.workingMemory.scope !== 'thread') {
    return;
  }

  const existingThread = await memory.getThreadById({ threadId });
  if (existingThread) {
    return;
  }

  await memory.saveThread({
    thread: {
      id: threadId,
      resourceId,
      title: threadId,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    memoryConfig,
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId')?.trim() || undefined;
    const { config, threadId, resourceId, memoryConfig } = await resolveLocationMemoryContext(conversationId);
    const memory = await getMastraMemory();
    const workingMemoryRaw = await memory.getWorkingMemory({
      threadId,
      resourceId,
      memoryConfig,
    });
    const profile = parseWorkingMemoryProfile(workingMemoryRaw);
    const location = readStoredLocation(profile);

    return Response.json({
      ok: true,
      enabled: true,
      scope: config.mastraMemory.workingMemory.scope,
      location,
      stale: location ? isStaleLocation(location.capturedAt) : false,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unable to read location' },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const saveParsed = LocationSaveRequestSchema.safeParse(body);
    if (saveParsed.success) {
      const { conversationId, assistantRequest, ...location } = saveParsed.data;
      if (assistantRequest && assistantRequest.status !== 'saved') {
        return Response.json(
          { ok: false, error: 'assistantRequest.status must be saved when location coordinates are provided.' },
          { status: 400 },
        );
      }

      const { config, threadId, resourceId, memoryConfig } = await resolveLocationMemoryContext(conversationId);
      if (assistantRequest) {
        validatePendingLocationRequest({
          requestId: assistantRequest.requestId,
          nonce: assistantRequest.nonce,
          state: assistantRequest.state,
          resourceId,
          conversationId,
        });
      }
      const memory = await getMastraMemory();
      await ensureThreadScopedWorkingMemoryThread(memory, threadId, resourceId, memoryConfig);
      const existingRaw = await memory.getWorkingMemory({
        threadId,
        resourceId,
        memoryConfig,
      });
      const mergedProfile = mergeStoredLocation(parseWorkingMemoryProfile(existingRaw), location);

      await memory.updateWorkingMemory({
        threadId,
        resourceId,
        workingMemory: serializeWorkingMemoryProfile(mergedProfile),
        memoryConfig,
      });

      const storedLocation = readStoredLocation(mergedProfile);
      if (assistantRequest) {
        resolvePendingLocationRequest({
          requestId: assistantRequest.requestId,
          nonce: assistantRequest.nonce,
          state: assistantRequest.state,
          resourceId,
          conversationId,
          status: 'saved',
          message: assistantRequest.message?.trim() || defaultAssistantLocationMessage('saved'),
          location: storedLocation,
        });
      }

      return Response.json({
        ok: true,
        enabled: true,
        scope: config.mastraMemory.workingMemory.scope,
        location: storedLocation,
        stale: storedLocation ? isStaleLocation(storedLocation.capturedAt) : false,
      });
    }

    const resolutionParsed = AssistantLocationResolutionSchema.safeParse(body);
    if (!resolutionParsed.success) {
      return Response.json({ ok: false, error: 'Invalid location payload', details: resolutionParsed.error.flatten() }, { status: 400 });
    }

    const { conversationId, assistantRequest } = resolutionParsed.data;
    if (assistantRequest.status === 'saved') {
      return Response.json({ ok: false, error: 'Saved assistant location requests must include location coordinates.' }, { status: 400 });
    }

    const resourceId = resolveAuthenticatedResourceId();
    const resolution = resolvePendingLocationRequest({
      requestId: assistantRequest.requestId,
      nonce: assistantRequest.nonce,
      state: assistantRequest.state,
      resourceId,
      conversationId,
      status: assistantRequest.status,
      message: assistantRequest.message?.trim() || defaultAssistantLocationMessage(assistantRequest.status),
    });

    return Response.json({
      ok: true,
      resolved: true,
      requestId: resolution.requestId,
      status: resolution.status,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unable to save location' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = LocationDeletePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'Invalid location delete payload', details: parsed.error.flatten() }, { status: 400 });
    }

    const conversationId = parsed.data.conversationId;
    const { config, threadId, resourceId, memoryConfig } = await resolveLocationMemoryContext(conversationId);
    const memory = await getMastraMemory();
    await ensureThreadScopedWorkingMemoryThread(memory, threadId, resourceId, memoryConfig);
    const existingRaw = await memory.getWorkingMemory({
      threadId,
      resourceId,
      memoryConfig,
    });
    const clearedProfile = clearStoredLocation(parseWorkingMemoryProfile(existingRaw));

    await memory.updateWorkingMemory({
      threadId,
      resourceId,
      workingMemory: serializeWorkingMemoryProfile(clearedProfile),
      memoryConfig,
    });

    return Response.json({
      ok: true,
      enabled: true,
      scope: config.mastraMemory.workingMemory.scope,
      location: null,
      stale: false,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unable to clear location' },
      { status: 400 },
    );
  }
}
