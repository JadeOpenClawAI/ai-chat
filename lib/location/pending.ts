import type { StoredLocation } from '@/lib/mastra/working-memory';
import type { StreamAnnotation } from '@/lib/types';

export const LOCATION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export type PendingLocationResolutionStatus =
  | 'saved'
  | 'cancelled'
  | 'denied'
  | 'error'
  | 'timed-out';

export interface PendingLocationResolution {
  requestId: string;
  status: PendingLocationResolutionStatus;
  message?: string;
  location?: StoredLocation | null;
}

interface PendingLocationRequestEntry {
  requestId: string;
  nonce: string;
  state: string;
  resourceId: string;
  conversationId?: string;
  emitAnnotation?: (annotation: StreamAnnotation) => void;
  resolvePromise: (resolution: PendingLocationResolution) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

export interface CreatePendingLocationRequestOptions {
  resourceId: string;
  conversationId?: string;
  reason?: string;
  resumeLabel?: string;
  timeoutMs?: number;
  emitAnnotation?: (annotation: StreamAnnotation) => void;
}

export interface LocationRequestSession {
  request: (reason?: string) => {
    wasCreated: boolean;
    annotation?: Extract<StreamAnnotation, { type: 'location-request' }>;
    waitForResolution: () => Promise<PendingLocationResolution>;
  };
  cancelActive: (message?: string) => PendingLocationResolution | null;
}

export interface ResolvePendingLocationRequestInput {
  requestId: string;
  nonce: string;
  state: string;
  resourceId: string;
  conversationId?: string;
  status: Exclude<PendingLocationResolutionStatus, 'timed-out'>;
  message?: string;
  location?: StoredLocation | null;
}

const pendingRequests = new Map<string, PendingLocationRequestEntry>();

function getPendingLocationRequestEntry(input: {
  requestId: string;
  nonce: string;
  state: string;
  resourceId: string;
  conversationId?: string;
}): PendingLocationRequestEntry {
  const entry = pendingRequests.get(input.requestId);
  if (!entry || entry.resolved) {
    throw new Error('Location request is no longer pending.');
  }
  if (entry.resourceId !== input.resourceId) {
    throw new Error('Location request does not belong to the current resource.');
  }
  if (entry.nonce !== input.nonce || entry.state !== input.state) {
    throw new Error('Location request state or nonce did not match.');
  }
  if ((entry.conversationId ?? '') !== (input.conversationId ?? '')) {
    throw new Error('Location request conversation did not match.');
  }
  return entry;
}

function finishPendingRequest(
  entry: PendingLocationRequestEntry,
  resolution: PendingLocationResolution,
): PendingLocationResolution {
  if (entry.resolved) {
    return resolution;
  }

  entry.resolved = true;
  clearTimeout(entry.timeoutHandle);
  pendingRequests.delete(entry.requestId);
  entry.emitAnnotation?.({
    type: 'location-status',
    requestId: entry.requestId,
    status: resolution.status,
    ...(resolution.message?.trim() ? { message: resolution.message.trim() } : {}),
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
  });
  entry.resolvePromise(resolution);
  return resolution;
}

export function createPendingLocationRequest(options: CreatePendingLocationRequestOptions): {
  annotation: Extract<StreamAnnotation, { type: 'location-request' }>;
  waitForResolution: () => Promise<PendingLocationResolution>;
  cancel: (message?: string) => PendingLocationResolution;
} {
  const requestId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const state = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? LOCATION_REQUEST_TIMEOUT_MS;
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

  let resolvePromise: ((resolution: PendingLocationResolution) => void) | null = null;
  const promise = new Promise<PendingLocationResolution>((resolve) => {
    resolvePromise = resolve;
  });

  const entry: PendingLocationRequestEntry = {
    requestId,
    nonce,
    state,
    resourceId: options.resourceId,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    emitAnnotation: options.emitAnnotation,
    resolvePromise: (resolution) => {
      resolvePromise?.(resolution);
    },
    timeoutHandle: setTimeout(() => {
      finishPendingRequest(entry, {
        requestId,
        status: 'timed-out',
        message: 'Location request timed out after 5 minutes.',
      });
    }, timeoutMs),
    resolved: false,
  };

  pendingRequests.set(requestId, entry);

  return {
    annotation: {
      type: 'location-request',
      requestId,
      nonce,
      state,
      expiresAt,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
      ...(options.resumeLabel?.trim() ? { resumeLabel: options.resumeLabel.trim() } : {}),
    },
    waitForResolution: () => promise,
    cancel: (message) => finishPendingRequest(entry, {
      requestId,
      status: 'cancelled',
      message: message?.trim() || 'Location request cancelled.',
    }),
  };
}

export function createLocationRequestSession(
  options: Omit<CreatePendingLocationRequestOptions, 'reason'>,
): LocationRequestSession {
  let activeRequest: ReturnType<typeof createPendingLocationRequest> | null = null;
  let activeResolution: Promise<PendingLocationResolution> | null = null;
  let finalResolution: PendingLocationResolution | null = null;

  const clearActiveRequest = (requestId: string) => {
    if (activeRequest?.annotation.requestId !== requestId) {
      return;
    }
    activeRequest = null;
    activeResolution = null;
  };

  return {
    request: (reason) => {
      if (finalResolution) {
        const resolved = finalResolution;
        return {
          wasCreated: false,
          waitForResolution: async () => resolved,
        };
      }

      if (activeRequest && activeResolution) {
        return {
          wasCreated: false,
          annotation: activeRequest.annotation,
          waitForResolution: () => activeResolution as Promise<PendingLocationResolution>,
        };
      }

      const pendingRequest = createPendingLocationRequest({
        ...options,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      });
      const resolutionPromise = pendingRequest.waitForResolution().then((resolution) => {
        finalResolution = resolution;
        clearActiveRequest(pendingRequest.annotation.requestId);
        return resolution;
      }, (error) => {
        clearActiveRequest(pendingRequest.annotation.requestId);
        throw error;
      });

      activeRequest = pendingRequest;
      activeResolution = resolutionPromise;
      options.emitAnnotation?.(pendingRequest.annotation);

      return {
        wasCreated: true,
        annotation: pendingRequest.annotation,
        waitForResolution: () => resolutionPromise,
      };
    },
    cancelActive: (message) => {
      if (!activeRequest) {
        return finalResolution;
      }
      return activeRequest.cancel(message);
    },
  };
}

export function resolvePendingLocationRequest(input: ResolvePendingLocationRequestInput): PendingLocationResolution {
  const entry = getPendingLocationRequestEntry(input);
  return finishPendingRequest(entry, {
    requestId: input.requestId,
    status: input.status,
    ...(input.message?.trim() ? { message: input.message.trim() } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
  });
}

export function validatePendingLocationRequest(input: {
  requestId: string;
  nonce: string;
  state: string;
  resourceId: string;
  conversationId?: string;
}): void {
  getPendingLocationRequestEntry(input);
}

export function hasPendingLocationRequest(requestId: string): boolean {
  return pendingRequests.has(requestId);
}

export function clearPendingLocationRequestsForTests(): void {
  for (const entry of pendingRequests.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pendingRequests.clear();
}
