// ============================================================
// Streaming Helpers
// Utilities for working with Vercel AI SDK data streams
// ============================================================

import type { StreamAnnotation } from '@/lib/types'

/**
 * Builds a tool-state annotation to send via the data stream.
 */
export function toolStateAnnotation(
  toolCallId: string,
  toolName: string,
  state: StreamAnnotation extends { type: 'tool-state' } ? StreamAnnotation['state'] : never,
  extra?: Partial<Omit<Extract<StreamAnnotation, { type: 'tool-state' }>, 'type' | 'toolCallId' | 'toolName' | 'state'>>,
): Extract<StreamAnnotation, { type: 'tool-state' }> {
  return {
    type: 'tool-state',
    toolCallId,
    toolName,
    state,
    ...extra,
  } as Extract<StreamAnnotation, { type: 'tool-state' }>
}

/**
 * Builds a context-stats annotation to send via the data stream.
 */
export function contextAnnotation(
  used: number,
  limit: number,
  wasCompacted: boolean,
  compactionMode?: Extract<StreamAnnotation, { type: 'context-stats' }>['compactionMode'],
  tokensFreed?: Extract<StreamAnnotation, { type: 'context-stats' }>['tokensFreed'],
): Extract<StreamAnnotation, { type: 'context-stats' }> {
  return {
    type: 'context-stats',
    used,
    limit,
    percentage: used / limit,
    wasCompacted,
    compactionMode,
    tokensFreed,
  }
}

/**
 * Extracts annotations of a specific type from a data message.
 */
export function extractAnnotations<T extends StreamAnnotation>(
  annotations: unknown[],
  type: T['type'],
): T[] {
  return annotations.filter(
    (a): a is T =>
      typeof a === 'object' && a !== null && (a as StreamAnnotation).type === type,
  )
}
