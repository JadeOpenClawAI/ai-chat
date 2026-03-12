import { readConfig } from '@/lib/config/store';
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
    const parsed = LocationPayloadSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'Invalid location payload', details: parsed.error.flatten() }, { status: 400 });
    }

    const { conversationId, ...location } = parsed.data;
    const { config, threadId, resourceId, memoryConfig } = await resolveLocationMemoryContext(conversationId);
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
    return Response.json({
      ok: true,
      enabled: true,
      scope: config.mastraMemory.workingMemory.scope,
      location: storedLocation,
      stale: storedLocation ? isStaleLocation(storedLocation.capturedAt) : false,
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
