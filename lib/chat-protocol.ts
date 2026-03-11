import type { StreamAnnotation } from '@/lib/types';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextUIPart {
  type: 'text';
  text: string;
}

export interface FileUIPart {
  type: 'file';
  url: string;
  mediaType?: string;
  filename?: string;
}

export interface StepStartUIPart {
  type: 'step-start';
}

export type ToolUIPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

export interface ToolUIPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: ToolUIPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export type UIMessagePart = TextUIPart | FileUIPart | StepStartUIPart | ToolUIPart;

export interface UIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: UIMessagePart[];
  createdAt?: string | Date;
}

export interface ModelMessage {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
}

export type ChatStreamEvent =
  | {
    type: 'message-start';
    messageId: string;
    role: 'assistant';
    createdAt?: string;
  }
  | {
    type: 'step-start';
    messageId: string;
  }
  | {
    type: 'text-delta';
    messageId: string;
    text: string;
  }
  | {
    type: 'tool-input-start';
    messageId: string;
    toolCallId: string;
    toolName: string;
  }
  | {
    type: 'tool-input-delta';
    messageId: string;
    toolCallId: string;
    delta: string;
  }
  | {
    type: 'tool-call';
    messageId: string;
    toolCallId: string;
    toolName: string;
    input?: unknown;
  }
  | {
    type: 'tool-result';
    messageId: string;
    toolCallId: string;
    toolName: string;
    output: unknown;
    isError?: boolean;
    errorText?: string;
  }
  | {
    type: 'annotation';
    data: StreamAnnotation;
  }
  | {
    type: 'finish';
    messageId?: string;
    finishReason?: string;
  }
  | {
    type: 'error';
    errorText: string;
  };

export function isToolUIPart(part: UIMessagePart): part is ToolUIPart {
  return typeof part.type === 'string' && part.type.startsWith('tool-');
}

export function getToolName(part: ToolUIPart): string {
  return part.type.slice('tool-'.length);
}

function toToolPartType(toolName: string): `tool-${string}` {
  return `tool-${toolName}` as `tool-${string}`;
}

function upsertMessage(messages: UIMessage[], nextMessage: UIMessage): UIMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id);
  if (existingIndex >= 0) {
    const next = [...messages];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...messages, nextMessage];
}

function ensureAssistantMessage(
  messages: UIMessage[],
  messageId: string,
  createdAt?: string,
): { messages: UIMessage[]; message: UIMessage } {
  const existing = messages.find((message) => message.id === messageId && message.role === 'assistant');
  if (existing) {
    return { messages, message: existing };
  }

  const nextMessage: UIMessage = {
    id: messageId,
    role: 'assistant',
    createdAt,
    parts: [],
  };

  return {
    messages: [...messages, nextMessage],
    message: nextMessage,
  };
}

function updateAssistantMessage(
  messages: UIMessage[],
  messageId: string,
  updater: (message: UIMessage) => UIMessage,
  createdAt?: string,
): { messages: UIMessage[]; message: UIMessage } {
  const ensured = ensureAssistantMessage(messages, messageId, createdAt);
  const updatedMessage = updater(ensured.message);
  return {
    messages: upsertMessage(ensured.messages, updatedMessage),
    message: updatedMessage,
  };
}

export function applyChatStreamEvent(
  messages: UIMessage[],
  event: ChatStreamEvent,
): { messages: UIMessage[]; updatedMessage?: UIMessage; errorText?: string } {
  switch (event.type) {
    case 'message-start': {
      const ensured = ensureAssistantMessage(messages, event.messageId, event.createdAt);
      return { messages: ensured.messages, updatedMessage: ensured.message };
    }

    case 'step-start': {
      const updated = updateAssistantMessage(messages, event.messageId, (message) => {
        const lastPart = message.parts[message.parts.length - 1];
        if (lastPart?.type === 'step-start') {
          return message;
        }
        return {
          ...message,
          parts: [...message.parts, { type: 'step-start' }],
        };
      });
      return { messages: updated.messages, updatedMessage: updated.message };
    }

    case 'text-delta': {
      const updated = updateAssistantMessage(messages, event.messageId, (message) => {
        const parts = [...message.parts];
        const lastPart = parts[parts.length - 1];
        if (lastPart?.type === 'text') {
          parts[parts.length - 1] = {
            ...lastPart,
            text: `${lastPart.text}${event.text}`,
          };
        } else {
          parts.push({ type: 'text', text: event.text });
        }
        return {
          ...message,
          parts,
        };
      });
      return { messages: updated.messages, updatedMessage: updated.message };
    }

    case 'tool-input-start': {
      const updated = updateAssistantMessage(messages, event.messageId, (message) => {
        const nextPart: ToolUIPart = {
          type: toToolPartType(event.toolName),
          toolCallId: event.toolCallId,
          state: 'input-streaming',
        };
        const existingIndex = message.parts.findIndex(
          (part) => isToolUIPart(part) && part.toolCallId === event.toolCallId,
        );
        if (existingIndex >= 0) {
          const parts = [...message.parts];
          parts[existingIndex] = {
            ...parts[existingIndex] as ToolUIPart,
            ...nextPart,
          };
          return { ...message, parts };
        }
        return {
          ...message,
          parts: [...message.parts, nextPart],
        };
      });
      return { messages: updated.messages, updatedMessage: updated.message };
    }

    case 'tool-input-delta': {
      return { messages };
    }

    case 'tool-call': {
      const updated = updateAssistantMessage(messages, event.messageId, (message) => {
        const parts = message.parts.map((part) => {
          if (!isToolUIPart(part) || part.toolCallId !== event.toolCallId) {
            return part;
          }
          return {
            ...part,
            type: toToolPartType(event.toolName),
            state: 'input-available' as const,
            input: event.input,
          };
        });

        const hasPart = parts.some((part) => isToolUIPart(part) && part.toolCallId === event.toolCallId);
        if (!hasPart) {
          parts.push({
            type: toToolPartType(event.toolName),
            toolCallId: event.toolCallId,
            state: 'input-available',
            input: event.input,
          });
        }

        return {
          ...message,
          parts,
        };
      });
      return { messages: updated.messages, updatedMessage: updated.message };
    }

    case 'tool-result': {
      const updated = updateAssistantMessage(messages, event.messageId, (message) => {
        const parts = message.parts.map((part) => {
          if (!isToolUIPart(part) || part.toolCallId !== event.toolCallId) {
            return part;
          }
          return {
            ...part,
            type: toToolPartType(event.toolName),
            state: event.isError ? 'output-error' as const : 'output-available' as const,
            output: event.output,
            errorText: event.errorText,
          };
        });

        const hasPart = parts.some((part) => isToolUIPart(part) && part.toolCallId === event.toolCallId);
        if (!hasPart) {
          parts.push({
            type: toToolPartType(event.toolName),
            toolCallId: event.toolCallId,
            state: event.isError ? 'output-error' : 'output-available',
            output: event.output,
            errorText: event.errorText,
          });
        }

        return {
          ...message,
          parts,
        };
      });
      return { messages: updated.messages, updatedMessage: updated.message };
    }

    case 'annotation':
    case 'finish': {
      return { messages };
    }

    case 'error': {
      return { messages, errorText: event.errorText };
    }

    default: {
      return { messages };
    }
  }
}

export function parseChatEventStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emitBlocks = (
    controller: ReadableStreamDefaultController<ChatStreamEvent>,
    flushRemainder: boolean,
  ) => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    let start = 0;

    while (true) {
      const boundaryIndex = normalized.indexOf('\n\n', start);
      if (boundaryIndex === -1) {
        break;
      }
      const block = normalized.slice(start, boundaryIndex);
      start = boundaryIndex + 2;
      const payload = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      try {
        controller.enqueue(JSON.parse(payload) as ChatStreamEvent);
      } catch {
        // Ignore malformed events.
      }
    }

    buffer = normalized.slice(start);

    if (flushRemainder) {
      const payload = buffer
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (payload && payload !== '[DONE]') {
        try {
          controller.enqueue(JSON.parse(payload) as ChatStreamEvent);
        } catch {
          // Ignore malformed events.
        }
      }
      buffer = '';
    }
  };

  return new ReadableStream<ChatStreamEvent>({
    start(controller) {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              buffer += decoder.decode(value, { stream: true });
              emitBlocks(controller, false);
            }
          }
          buffer += decoder.decode();
          emitBlocks(controller, true);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      };
      void pump();
    },
    cancel() {
      return reader.cancel();
    },
  });
}

async function* streamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
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

export async function* readChatMessageStream(options: {
  stream: ReadableStream<ChatStreamEvent>;
  terminateOnError?: boolean;
  onAnnotation?: (annotation: StreamAnnotation) => void;
}): AsyncIterable<UIMessage> {
  const {
    stream,
    terminateOnError = false,
    onAnnotation,
  } = options;
  let messages: UIMessage[] = [];

  for await (const event of streamToAsyncIterable(stream)) {
    if (event.type === 'annotation') {
      onAnnotation?.(event.data);
      continue;
    }

    const next = applyChatStreamEvent(messages, event);
    messages = next.messages;

    if (next.errorText) {
      if (terminateOnError) {
        throw new Error(next.errorText);
      }
      continue;
    }

    if (next.updatedMessage) {
      yield next.updatedMessage;
    }
  }
}
