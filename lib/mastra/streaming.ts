import type { StreamAnnotation } from '@/lib/types';
import type { ChatStreamEvent } from '@/lib/chat-protocol';
import { isLocationRequestInterruptError } from '@/lib/location/interrupt';

export type MastraFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown'
  | string;

export type MastraTextStreamPart =
  & { type: string; payload?: Record<string, unknown> }
  & Record<string, unknown>;

export interface StreamProbeResult {
  firstPart: MastraTextStreamPart;
  rest: AsyncIterable<MastraTextStreamPart>;
}

export interface StreamingAnnotationSource {
  emit: (annotation: StreamAnnotation) => void;
  close: () => void;
  stream: AsyncIterable<StreamAnnotation>;
}

function toSseChunk(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function createStreamingAnnotationSource(): StreamingAnnotationSource {
  const queue: StreamAnnotation[] = [];
  const waiters: Array<(result: IteratorResult<StreamAnnotation>) => void> = [];
  let closed = false;

  return {
    emit(annotation) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: annotation, done: false });
        return;
      }
      queue.push(annotation);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<StreamAnnotation>>((resolve) => {
              waiters.push(resolve);
            });
          },
        };
      },
    },
  };
}

export function stringifyStreamError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function parseMastraToolInput(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readPayload(part: MastraTextStreamPart): Record<string, unknown> | undefined {
  return asRecord(part.payload);
}

export function getMastraPartType(part: MastraTextStreamPart): string {
  const rawType = readString(part.type) ?? '';
  switch (rawType) {
    case 'start-step':
      return 'step-start';
    case 'tool-call-input-streaming-start':
      return 'tool-input-start';
    case 'tool-call-delta':
      return 'tool-input-delta';
    case 'tool-call-input-streaming-end':
      return 'tool-input-end';
    case 'step-finish':
      return 'finish-step';
    case 'stream-start':
      return 'start';
    default:
      return rawType;
  }
}

export function readMastraTextDelta(part: MastraTextStreamPart): string {
  const payload = readPayload(part);
  return readString(part.text)
    ?? readString(part.delta)
    ?? readString(payload?.text)
    ?? readString(payload?.delta)
    ?? '';
}

export function readMastraToolCallId(part: MastraTextStreamPart): string {
  const payload = readPayload(part);
  return readString(part.toolCallId)
    ?? readString(payload?.toolCallId)
    ?? readString(part.id)
    ?? readString(payload?.id)
    ?? '';
}

export function readMastraToolName(part: MastraTextStreamPart): string {
  const payload = readPayload(part);
  return readString(part.toolName)
    ?? readString(payload?.toolName)
    ?? readString(part.name)
    ?? '';
}

export function readMastraToolInputDelta(part: MastraTextStreamPart): string {
  const payload = readPayload(part);
  return readString(part.delta)
    ?? readString(payload?.argsTextDelta)
    ?? readString(payload?.delta)
    ?? '';
}

export function readMastraToolInput(part: MastraTextStreamPart): unknown {
  const payload = readPayload(part);
  if (payload && 'args' in payload) {
    return payload.args;
  }
  if (payload && 'input' in payload) {
    return payload.input;
  }
  if ('args' in part) {
    return part.args;
  }
  if ('input' in part) {
    return part.input;
  }
  return {};
}

export function readMastraToolResult(part: MastraTextStreamPart): unknown {
  const payload = readPayload(part);
  if (payload && 'result' in payload) {
    return payload.result;
  }
  if (payload && 'output' in payload) {
    return payload.output;
  }
  if ('result' in part) {
    return part.result;
  }
  if ('output' in part) {
    return part.output;
  }
  return undefined;
}

export function readMastraToolIsError(part: MastraTextStreamPart): boolean {
  const payload = readPayload(part);
  return Boolean(payload?.isError ?? part.isError);
}

export function readMastraFinishReason(part: MastraTextStreamPart): string | undefined {
  const payload = readPayload(part);
  const stepResult = asRecord(payload?.stepResult);
  return readString(part.finishReason)
    ?? readString(payload?.finishReason)
    ?? readString(stepResult?.reason);
}

export function readMastraError(part: MastraTextStreamPart): unknown {
  const payload = readPayload(part);
  return payload?.error ?? part.error;
}

export function isMastraContentPart(part: MastraTextStreamPart): boolean {
  const partType = getMastraPartType(part);
  return partType === 'text-delta'
    || partType === 'reasoning-delta'
    || partType === 'tool-input-start'
    || partType === 'tool-call'
    || partType === 'tool-result';
}

export function isMastraFailurePart(part: MastraTextStreamPart): boolean {
  return getMastraPartType(part) === 'error';
}

export function mergeAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) {
    return second;
  }
  if (!second || first === second) {
    return first;
  }
  if (first.aborted) {
    return first;
  }
  if (second.aborted) {
    return second;
  }

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  first.addEventListener('abort', () => abortFrom(first), { once: true });
  second.addEventListener('abort', () => abortFrom(second), { once: true });
  return controller.signal;
}

export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return error.name === 'AbortError' || message.includes('aborted') || message.includes('abort');
  }
  return false;
}

async function* readableStreamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function toAsyncIterable(
  stream: AsyncIterable<MastraTextStreamPart> | ReadableStream<MastraTextStreamPart>,
): AsyncIterable<MastraTextStreamPart> {
  if ('getReader' in stream) {
    return readableStreamToAsyncIterable(stream);
  }
  return stream;
}

export async function probeMastraStream(
  stream: AsyncIterable<MastraTextStreamPart> | ReadableStream<MastraTextStreamPart>,
  options: {
    abortSignal?: AbortSignal;
    startupTimeoutMs?: number;
  } = {},
): Promise<StreamProbeResult> {
  const {
    abortSignal,
    startupTimeoutMs = 10_000,
  } = options;

  const iterator = toAsyncIterable(stream)[Symbol.asyncIterator]();
  const startupDeadline = Date.now() + startupTimeoutMs;
  let streamError: string | undefined;
  let firstPart: MastraTextStreamPart | undefined;

  while (Date.now() < startupDeadline) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Request aborted');
    }

    let next: IteratorResult<MastraTextStreamPart>;
    try {
      const msLeft = Math.max(1, startupDeadline - Date.now());
      next = await Promise.race([
        iterator.next() as Promise<IteratorResult<MastraTextStreamPart>>,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startup read timeout')), msLeft);
        }),
      ]);
    } catch (error) {
      if (isLocationRequestInterruptError(error)) {
        throw error;
      }
      streamError = stringifyStreamError(error);
      break;
    }

    if (next.done) {
      break;
    }

    const part = next.value;
    if (isMastraFailurePart(part)) {
      streamError = stringifyStreamError('error' in part ? part.error : undefined);
      break;
    }

    if (isMastraContentPart(part)) {
      firstPart = part;
      break;
    }
  }

  if (streamError || !firstPart) {
    throw new Error(streamError ?? 'Stream ended without producing any content');
  }

  const rest: AsyncIterable<MastraTextStreamPart> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return iterator.next() as Promise<IteratorResult<MastraTextStreamPart>>;
        },
        return(value) {
          return iterator.return?.(value) ?? Promise.resolve({ done: true as const, value });
        },
      };
    },
  };

  return { firstPart, rest };
}

function mastraPartToChatEvent(
  messageId: string,
  part: MastraTextStreamPart,
): ChatStreamEvent | null {
  switch (getMastraPartType(part)) {
    case 'step-start':
      return { type: 'step-start', messageId };

    case 'text-delta': {
      const text = readMastraTextDelta(part);
      if (!text) {
        return null;
      }
      return { type: 'text-delta', messageId, text };
    }

    case 'tool-input-start':
      return {
        type: 'tool-input-start',
        messageId,
        toolCallId: readMastraToolCallId(part),
        toolName: readMastraToolName(part),
      };

    case 'tool-input-delta': {
      const delta = readMastraToolInputDelta(part);
      if (!delta) {
        return null;
      }
      return {
        type: 'tool-input-delta',
        messageId,
        toolCallId: readMastraToolCallId(part),
        delta,
      };
    }

    case 'tool-call':
      return {
        type: 'tool-call',
        messageId,
        toolCallId: readMastraToolCallId(part),
        toolName: readMastraToolName(part),
        input: parseMastraToolInput(readMastraToolInput(part)),
      };

    case 'tool-result':
      return {
        type: 'tool-result',
        messageId,
        toolCallId: readMastraToolCallId(part),
        toolName: readMastraToolName(part),
        output: readMastraToolResult(part),
        isError: readMastraToolIsError(part),
        errorText: readMastraToolIsError(part) ? stringifyStreamError(readMastraToolResult(part)) : undefined,
      };

    case 'tool-error':
      return {
        type: 'tool-result',
        messageId,
        toolCallId: readMastraToolCallId(part),
        toolName: readMastraToolName(part),
        output: { error: stringifyStreamError(readMastraError(part)) },
        isError: true,
        errorText: stringifyStreamError(readMastraError(part)),
      };

    case 'finish':
      return {
        type: 'finish',
        messageId,
        finishReason: readMastraFinishReason(part),
      };

    case 'error':
      return {
        type: 'error',
        errorText: stringifyStreamError(readMastraError(part)),
      };

    default:
      return null;
  }
}

export function createChatEventStreamFromMastra(options: {
  messageId?: string;
  stream: AsyncIterable<MastraTextStreamPart>;
  annotations?: StreamAnnotation[];
  annotationStream?: AsyncIterable<StreamAnnotation>;
  onCloseAnnotations?: () => void;
  shouldSuppressError?: (error: unknown) => boolean;
}): ReadableStream<Uint8Array> {
  const {
    messageId = crypto.randomUUID(),
    stream,
    annotations = [],
    annotationStream,
    onCloseAnnotations,
    shouldSuppressError,
  } = options;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStarted = false;
      let hasLocationInterrupt = false;
      const seenLocationRequestIds = new Set<string>();
      const ensureMessageStarted = () => {
        if (messageStarted) {
          return;
        }
        messageStarted = true;
        controller.enqueue(toSseChunk({ type: 'message-start', messageId, role: 'assistant' }));
      };

      const enqueueAnnotation = (annotation: StreamAnnotation) => {
        if (annotation.type === 'location-request') {
          if (seenLocationRequestIds.has(annotation.requestId)) {
            return;
          }
          seenLocationRequestIds.add(annotation.requestId);
          hasLocationInterrupt = true;
        }
        controller.enqueue(toSseChunk({ type: 'annotation', data: annotation }));
      };

      for (const annotation of annotations) {
        enqueueAnnotation(annotation);
      }

      const annotationPump = annotationStream
        ? (async () => {
          try {
            for await (const annotation of annotationStream) {
              enqueueAnnotation(annotation);
            }
          } catch {
            // Ignore annotation channel failures; the main model stream decides the response outcome.
          }
        })()
        : Promise.resolve();

      let finished = false;
      try {
        for await (const part of stream) {
          const event = mastraPartToChatEvent(messageId, part);
          if (!event) {
            continue;
          }
          if (
            event.type === 'step-start'
            || event.type === 'text-delta'
            || event.type === 'tool-input-start'
            || event.type === 'tool-input-delta'
            || event.type === 'tool-call'
            || event.type === 'tool-result'
          ) {
            ensureMessageStarted();
          }
          controller.enqueue(toSseChunk(event));
          if (event.type === 'finish') {
            finished = true;
          }
        }
      } catch (error) {
        if (isLocationRequestInterruptError(error)) {
          if (error.annotation) {
            enqueueAnnotation(error.annotation);
          }
        } else if (!hasLocationInterrupt && !shouldSuppressError?.(error)) {
          controller.enqueue(toSseChunk({
            type: 'error',
            errorText: stringifyStreamError(error),
          }));
        }
      } finally {
        onCloseAnnotations?.();
        await annotationPump;
      }

      if (!finished) {
        controller.enqueue(toSseChunk(messageStarted ? { type: 'finish', messageId } : { type: 'finish' }));
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
