import type { ModelMessage, UIMessage, UIMessagePart, ToolUIPart } from '@/lib/chat-protocol';
import { isToolUIPart } from '@/lib/chat-protocol';

export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '(No output)';
  }
  try {
    const serialized = JSON.stringify(result, null, 2);
    return typeof serialized === 'string' ? serialized : String(result);
  } catch {
    return String(result);
  }
}

function toolPartToToolCallPart(part: ToolUIPart): Record<string, unknown> {
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName: part.type.slice('tool-'.length),
    input: part.input ?? {},
  };
}

function toolPartToToolResultMessage(part: ToolUIPart): ModelMessage | null {
  if (part.state !== 'output-available' && part.state !== 'output-error') {
    return null;
  }

  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.type.slice('tool-'.length),
      output: part.output ?? (part.errorText ? { error: part.errorText } : ''),
    }],
  };
}

function finalizeAssistantSegment(
  textParts: Array<{ type: 'text'; text: string }>,
  toolParts: ToolUIPart[],
): ModelMessage[] {
  if (textParts.length === 0 && toolParts.length === 0) {
    return [];
  }

  const assistantContent: Array<Record<string, unknown>> = [
    ...textParts,
    ...toolParts.map(toolPartToToolCallPart),
  ];

  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: assistantContent.length === 1 && assistantContent[0]?.type === 'text'
        ? String(assistantContent[0].text ?? '')
        : assistantContent,
    },
  ];

  for (const toolPart of toolParts) {
    const toolResultMessage = toolPartToToolResultMessage(toolPart);
    if (toolResultMessage) {
      messages.push(toolResultMessage);
    }
  }

  return messages;
}

function uiMessageToModelMessages(message: UIMessage): ModelMessage[] {
  if (message.role === 'system' || message.role === 'user') {
    const contentParts: Array<Record<string, unknown>> = [];

    for (const part of message.parts) {
      if (part.type === 'text') {
        contentParts.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'file' && (part.mediaType ?? '').startsWith('image/')) {
        contentParts.push({ type: 'image', image: part.url });
      }
    }

    if (contentParts.length === 1 && contentParts[0]?.type === 'text') {
      return [{ role: message.role, content: String(contentParts[0].text ?? '') }];
    }

    return [{
      role: message.role,
      content: contentParts,
    }];
  }

  const messages: ModelMessage[] = [];
  let textParts: Array<{ type: 'text'; text: string }> = [];
  let toolParts: ToolUIPart[] = [];

  const flush = () => {
    messages.push(...finalizeAssistantSegment(textParts, toolParts));
    textParts = [];
    toolParts = [];
  };

  for (const part of message.parts) {
    if (part.type === 'step-start') {
      flush();
      continue;
    }

    if (part.type === 'text') {
      if (part.text.trim().length > 0) {
        textParts.push({ type: 'text', text: part.text });
      }
      continue;
    }

    if (isToolUIPart(part)) {
      toolParts.push(part);
    }
  }

  flush();
  return messages;
}

export function toModelMessages(messages: Array<Record<string, unknown>>): ModelMessage[] {
  return messages.flatMap((message) => {
    const role = message.role;
    const rawParts = Array.isArray(message.parts) ? message.parts : undefined;

    if (rawParts) {
      const uiMessage: UIMessage = {
        id: typeof message.id === 'string' ? message.id : crypto.randomUUID(),
        role: role === 'assistant' || role === 'system' || role === 'user' ? role : 'user',
        parts: rawParts as UIMessagePart[],
      };
      return uiMessageToModelMessages(uiMessage);
    }

    const content = message.content;
    if (typeof content === 'string') {
      return [{
        role: role === 'assistant' || role === 'system' || role === 'user' || role === 'tool' ? role : 'user',
        content,
      }];
    }

    if (Array.isArray(content)) {
      return [{
        role: role === 'assistant' || role === 'system' || role === 'user' || role === 'tool' ? role : 'user',
        content: content as Array<Record<string, unknown>>,
      }];
    }

    return [];
  });
}

export function extractLatestUserText(messages: Array<Record<string, unknown> | ModelMessage>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown>;
    if (message.role !== 'user') {
      continue;
    }

    if (Array.isArray(message.parts)) {
      const text = message.parts
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (text) {
        return text;
      }
    }

    if (typeof message.content === 'string') {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (text) {
        return text;
      }
    }
  }

  return '';
}
