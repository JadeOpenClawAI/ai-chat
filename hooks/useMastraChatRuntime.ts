'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyChatStreamEvent,
  parseChatEventStream,
  type ChatStreamEvent,
  type UIMessage,
  type UIMessagePart,
} from '@/lib/chat-protocol';

export type ChatRuntimeStatus = 'submitted' | 'streaming' | 'ready' | 'error';

interface SendMessageOptions {
  body?: Record<string, unknown>;
}

interface SendMessageInput {
  id?: string;
  role?: 'user' | 'assistant' | 'system';
  parts?: UIMessagePart[];
}

interface UseMastraChatRuntimeOptions {
  api: string;
  throttleMs?: number;
  onData?: (part: { type: string; data?: unknown }) => void;
  onResponse?: (response: Response) => void;
}

function normalizeMessage(input: SendMessageInput): UIMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    role: input.role ?? 'user',
    parts: Array.isArray(input.parts) ? input.parts : [],
  };
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const data = await response.clone().json() as { error?: unknown };
    if (typeof data.error === 'string') {
      return data.error;
    }
    if (data.error && typeof data.error === 'object') {
      const typed = data.error as { message?: unknown };
      if (typeof typed.message === 'string') {
        return typed.message;
      }
    }
  } catch {
    // Fall back to plain text.
  }

  try {
    const text = await response.text();
    if (text.trim()) {
      return text.trim();
    }
  } catch {
    // Ignore secondary read failure.
  }

  return `Request failed (${response.status})`;
}

export function useMastraChatRuntime(options: UseMastraChatRuntimeOptions) {
  const {
    api,
    throttleMs = 120,
    onData,
    onResponse,
  } = options;

  const [messages, setMessagesState] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatRuntimeStatus>('ready');
  const [error, setError] = useState<Error | undefined>(undefined);
  const messagesRef = useRef<UIMessage[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setMessages = useCallback((next: UIMessage[]) => {
    messagesRef.current = next;
    setMessagesState(next);
  }, []);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    clearFlushTimer();
    setStatus('ready');
  }, [clearFlushTimer]);

  const regenerate = useCallback(async () => {
    // Regeneration is orchestrated by the higher-level chat hook.
  }, []);

  const performRequest = useCallback(async (
    nextMessages: UIMessage[],
    requestOptions: SendMessageOptions = {},
    options?: { skipSetMessages?: boolean },
  ) => {
    if (!options?.skipSetMessages) {
      setMessages(nextMessages);
    }
    setError(undefined);
    setStatus('submitted');

    const controller = new AbortController();
    controllerRef.current = controller;

    let workingMessages = nextMessages;
    const flushMessages = () => {
      clearFlushTimer();
      lastFlushAtRef.current = Date.now();
      setMessages(workingMessages);
    };

    const scheduleFlush = () => {
      const elapsed = Date.now() - lastFlushAtRef.current;
      if (elapsed >= throttleMs) {
        flushMessages();
        return;
      }
      if (flushTimerRef.current !== null) {
        return;
      }
      flushTimerRef.current = window.setTimeout(() => {
        flushMessages();
      }, Math.max(0, throttleMs - elapsed));
    };

    try {
      const response = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...(requestOptions.body ?? {}),
          messages: nextMessages,
        }),
      });
      onResponse?.(response);

      if (!response.ok || !response.body) {
        throw new Error(await readErrorResponse(response));
      }

      setStatus('streaming');
      const eventStream = parseChatEventStream(response.body);
      const reader = eventStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }

          const event = value as ChatStreamEvent;
          if (event.type === 'annotation') {
            onData?.({ type: `data-${event.data.type}`, data: event.data });
            continue;
          }

          const next = applyChatStreamEvent(workingMessages, event);
          workingMessages = next.messages;
          if (next.updatedMessage) {
            scheduleFlush();
          }
          if (next.errorText) {
            throw new Error(next.errorText);
          }
        }
      } finally {
        reader.releaseLock();
      }

      flushMessages();
      setStatus('ready');
    } catch (requestError) {
      flushMessages();
      if (controller.signal.aborted) {
        setStatus('ready');
      } else {
        const runtimeError = requestError instanceof Error
          ? requestError
          : new Error(String(requestError));
        setError(runtimeError);
        setStatus('error');
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      clearFlushTimer();
    }
  }, [api, clearFlushTimer, onData, onResponse, setMessages, throttleMs]);

  const sendMessage = useCallback(async (
    input?: SendMessageInput,
    requestOptions: SendMessageOptions = {},
  ) => {
    const normalizedMessage = normalizeMessage(input ?? { role: 'user', parts: [] });
    const nextMessages = [...messagesRef.current, normalizedMessage];
    await performRequest(nextMessages, requestOptions);
  }, [performRequest, setMessages]);

  const submitMessages = useCallback(async (
    messages: UIMessage[],
    requestOptions: SendMessageOptions = {},
  ) => {
    const normalizedMessages = messages.map((message) => normalizeMessage(message));
    setMessages(normalizedMessages);
    await performRequest(normalizedMessages, requestOptions, { skipSetMessages: true });
  }, [performRequest, setMessages]);

  return {
    messages,
    status,
    error,
    sendMessage,
    submitMessages,
    setMessages,
    stop,
    regenerate,
  };
}
