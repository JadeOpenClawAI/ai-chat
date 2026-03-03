/* eslint-disable max-len */
// ============================================================
// Message List Component
// Renders streaming messages with tool call progress, variant
// navigation, and retry/regenerate affordances.
// ============================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import { isToolUIPart, getToolName } from 'ai';
import type { ToolCallMeta } from '@/lib/types';
import { ToolCallProgress } from './ToolCallProgress';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { cn } from '@/lib/utils';
import { Bot, User, ChevronLeft, ChevronRight, RotateCcw, AlertTriangle, Copy, Check, StopCircle } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MessageListProps {
  messages: UIMessage[];
  isLoading: boolean;
  toolCallStates: Record<string, ToolCallMeta>;
  assistantVariantMeta: Record<string, { turnKey: string; variantIndex: number; variantCount: number }>;
  hiddenAssistantMessageIds?: string[];
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void;
  onRegenerate: (assistantMessageId: string) => void;
}

function stringifyWithLimit(value: unknown, maxChars = 4000): string {
  try {
    const raw = JSON.stringify(value, null, 2);
    if (raw.length <= maxChars) {
      return raw;
    }
    return `${raw.slice(0, maxChars)}\n... (truncated ${raw.length - maxChars} chars)`;
  } catch {
    return String(value);
  }
}

function extractToolErrorFromOutput(output: unknown): string | undefined {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const objectError = (output as { error?: unknown }).error;
    if (typeof objectError === 'string' && objectError.trim().length > 0) {
      return objectError;
    }
    return undefined;
  }

  if (typeof output !== 'string') {
    return undefined;
  }

  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }

  // If output is serialized JSON, prefer explicit top-level { error: string }.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed?.error === 'string' && parsed.error.trim().length > 0) {
        return parsed.error;
      }
    } catch {
      // Not JSON - continue with phrase matching below.
    }
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('error executing tool') || normalized.includes('failed to execute tool')) {
    return trimmed;
  }
  return undefined;
}

function isCompactedToolOutput(output: unknown): boolean {
  if (typeof output !== 'string') {
    return false;
  }
  const trimmed = output.trim();
  return (
    trimmed.startsWith('[Summarized')
    || trimmed.startsWith('[Truncated from ')
  );
}

export function MessageList({
  messages,
  isLoading,
  toolCallStates,
  assistantVariantMeta,
  hiddenAssistantMessageIds = [],
  onSwitchVariant,
  onRegenerate,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const keyboardAnchorRafRef = useRef<number | null>(null);
  const keyboardAnchorTimeoutsRef = useRef<number[]>([]);
  const isCompactionSummarySystemMessage = (message: UIMessage) =>
    message.role === 'system' &&
    message.parts.some(
      (p): p is Extract<typeof p, { type: 'text' }> =>
        p.type === 'text' && p.text.startsWith('[Conversation Summary]'),
    );

  const clearPendingKeyboardAnchors = () => {
    if (keyboardAnchorRafRef.current !== null) {
      window.cancelAnimationFrame(keyboardAnchorRafRef.current);
      keyboardAnchorRafRef.current = null;
    }
    for (const timeoutId of keyboardAnchorTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    keyboardAnchorTimeoutsRef.current = [];
  };

  const jumpToBottom = (behavior: ScrollBehavior = 'auto') => {
    const list = listRef.current;
    if (list) {
      if (behavior === 'smooth') {
        list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
      } else {
        list.scrollTop = list.scrollHeight;
      }
    }
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  };

  // Auto-scroll to bottom on new content
  useEffect(() => {
    jumpToBottom('smooth');
  }, [messages, isLoading]);

  // Keep the thread anchored to the latest message when the mobile keyboard
  // changes the visual viewport while a text field is focused.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const isTextEntryFocused = () => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) {
        return true;
      }
      if (active instanceof HTMLInputElement) {
        const type = (active.type || 'text').toLowerCase();
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
      }
      return active instanceof HTMLElement && active.isContentEditable;
    };

    const anchorToBottom = () => {
      if (!isTextEntryFocused()) {
        return;
      }
      clearPendingKeyboardAnchors();
      jumpToBottom('auto');

      keyboardAnchorRafRef.current = window.requestAnimationFrame(() => {
        jumpToBottom('auto');
        keyboardAnchorRafRef.current = window.requestAnimationFrame(() => {
          jumpToBottom('auto');
          keyboardAnchorRafRef.current = null;
        });
      });

      for (const delay of [40, 120, 220]) {
        const timeoutId = window.setTimeout(() => {
          jumpToBottom('auto');
        }, delay);
        keyboardAnchorTimeoutsRef.current.push(timeoutId);
      }
    };

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', anchorToBottom);
    visualViewport?.addEventListener('scroll', anchorToBottom);
    window.addEventListener('focusin', anchorToBottom);

    return () => {
      clearPendingKeyboardAnchors();
      visualViewport?.removeEventListener('resize', anchorToBottom);
      visualViewport?.removeEventListener('scroll', anchorToBottom);
      window.removeEventListener('focusin', anchorToBottom);
    };
  }, []);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-gray-100 p-4 dark:bg-gray-800">
          <Bot className="h-8 w-8 text-gray-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">
            How can I help you?
          </h2>
          <p className="mt-1 text-sm text-gray-400 dark:text-gray-500">
            Ask anything, upload files, or use the available tools.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {STARTER_PROMPTS.map((prompt) => (
            <div
              key={prompt}
              className="cursor-default rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              {prompt}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const filteredMessages = messages.filter((m) => {
    if (m.role === 'assistant' && hiddenAssistantMessageIds.includes(m.id)) {
      return false;
    }
    if (isCompactionSummarySystemMessage(m)) {
      return false;
    }
    return true;
  });
  const lastMessageId = filteredMessages[filteredMessages.length - 1]?.id;

  return (
    <div ref={listRef} className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-y-contain px-4 py-6">
      {filteredMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isLoading={isLoading}
          isStreamingThis={isLoading && message.id === lastMessageId && message.role === 'assistant'}
          toolCallStates={toolCallStates}
          variantMeta={assistantVariantMeta[message.id]}
          onSwitchVariant={onSwitchVariant}
          onRegenerate={onRegenerate}
        />
      ))}

      {/* Loading indicator when no assistant message exists yet */}
      {isLoading && (filteredMessages[filteredMessages.length - 1]?.role === 'user') && (
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#7C3AED]">
            <Bot className="h-4 w-4 text-white" />
          </div>
          <div className="rounded-2xl rounded-tl-none bg-gray-100 px-4 py-3 dark:bg-gray-800">
            <LoadingDots />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────

interface MessageBubbleProps {
  message: UIMessage;
  isLoading: boolean;
  isStreamingThis: boolean;
  toolCallStates: Record<string, ToolCallMeta>;
  variantMeta?: { turnKey: string; variantIndex: number; variantCount: number };
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void;
  onRegenerate: (assistantMessageId: string) => void;
}

type MessagePart = UIMessage['parts'][number];
type ToolPart = Extract<MessagePart, { type: `tool-${string}` }>;

function getMessageParts(message: UIMessage): MessagePart[] {
  return message.parts;
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function getToolPartsFromParts(parts: MessagePart[]): ToolPart[] {
  return parts.filter((p): p is ToolPart => isToolUIPart(p));
}

function renderToolPart(
  part: ToolPart,
  toolCallStates: Record<string, ToolCallMeta>,
) {
  const toolName = getToolName(part);
  const trackedState = toolCallStates[part.toolCallId];
  const hasOutput = part.state === 'output-available' || part.state === 'output-error';
  const outputError = hasOutput ? extractToolErrorFromOutput(part.output) : undefined;
  const inferredCompacted = hasOutput && isCompactedToolOutput(part.output);
  const fallbackError = part.state === 'output-error'
    ? String(part.errorText ?? outputError ?? 'Tool error')
    : outputError;
  const meta: ToolCallMeta = trackedState
    ? {
      ...trackedState,
      resultSummarized: Boolean(trackedState.resultSummarized) || inferredCompacted,
    }
    : {
      toolCallId: part.toolCallId,
      toolName,
      state:
        fallbackError
          ? 'error'
          : part.state === 'input-streaming'
            ? 'streaming'
            : (part.state === 'output-available' ? 'done' : 'running'),
      error: fallbackError,
      resultSummarized: inferredCompacted || undefined,
    };
  const input =
    part.state === 'input-streaming'
      ? 'Building tool arguments...'
      : (part.input ? stringifyWithLimit(part.input) : undefined);

  return (
    <ToolCallProgress
      toolCall={meta}
      input={input}
      output={
        hasOutput
          ? typeof part.output === 'string'
            ? part.output as string
            : JSON.stringify(part.output, null, 2)
          : undefined
      }
    />
  );
}

function MessageBubble({
  message,
  isLoading,
  isStreamingThis,
  toolCallStates,
  variantMeta,
  onSwitchVariant,
  onRegenerate,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const messageParts = getMessageParts(message);
  const isAssistantError = !isUser && messageParts.some(
    (p): p is Extract<MessagePart, { type: 'text' }> =>
      p.type === 'text' && p.text.startsWith('❌ Error:'),
  );
  const isAssistantCanceled = !isUser && messageParts.some(
    (p): p is Extract<MessagePart, { type: 'text' }> =>
      p.type === 'text' && p.text.startsWith('⊘ Canceled'),
  );
  const messageToolParts = getToolPartsFromParts(messageParts);

  if (isSystem) {
    const systemText = messageParts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return (
      <div className="flex justify-center">
        <div className="rounded-full border border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400">
          📋 {systemText}
        </div>
      </div>
    );
  }

  // Controls are shown below each assistant bubble.
  // • While this specific message is still streaming → hide (not finalised yet)
  // • While any message is loading → disable but still show for non-streaming messages
  const showControls = !isSystem && !isStreamingThis;
  const hasMultipleVariants = variantMeta && variantMeta.variantCount > 1;
  const isFirst = variantMeta ? variantMeta.variantIndex === 0 : true;
  const isLast = variantMeta ? variantMeta.variantIndex >= variantMeta.variantCount - 1 : true;
  const hasPendingToolInvocations =
    !isUser &&
    messageToolParts.some((ti) => ti.state !== 'output-available' && ti.state !== 'output-error');

  const timestampRaw = (message as { createdAt?: string | Date }).createdAt;
  const timestamp = timestampRaw
    ? new Date(timestampRaw).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const handleCopy = async () => {
    const text = getMessageText(message);
    if (!text) {
      return;
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    // `group` enables hover-driven control visibility below
    <div
      className={cn(
        'group flex items-start gap-3',
        isUser && 'flex-row-reverse',
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm',
          isUser
            ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
            : isAssistantError
              ? 'bg-red-100 dark:bg-red-900'
              : isAssistantCanceled
                ? 'bg-orange-100 dark:bg-orange-900'
                : 'bg-[#7C3AED]',
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : isAssistantError ? (
          <AlertTriangle className="h-4 w-4 text-red-500 dark:text-red-400" />
        ) : isAssistantCanceled ? (
          <StopCircle className="h-4 w-4 text-orange-500 dark:text-orange-400" />
        ) : (
          <Bot className="h-4 w-4 text-white" />
        )}
      </div>
      {/* Content column */}
      <div className={cn('flex max-w-[85%] flex-col gap-1', isUser && 'items-end')}>
        {/* Bubble */}
        <div
          className={cn(
            'rounded-2xl px-4 py-3',
            isUser
              ? 'rounded-tr-none bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : isAssistantError
                ? 'rounded-tl-none border border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
                : isAssistantCanceled
                  ? 'rounded-tl-none border border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300'
                  : 'rounded-tl-none bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100',
          )}
        >
          {/* Image file attachments (v5: file parts in message.parts) */}
          {(() => {
            const imageParts = messageParts.filter(
              (p): p is Extract<MessagePart, { type: 'file' }> =>
                p.type === 'file' && (p.mediaType ?? '').startsWith('image/'),
            );
            return imageParts.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {imageParts.map((p, i) => (
                  <img
                    key={i}
                    src={p.url}
                    alt="attached image"
                    className="max-h-48 max-w-full rounded-lg object-cover"
                  />
                ))}
              </div>
            ) : null;
          })()}

          {/* Ordered message parts (text/tool/step) */}
          {messageParts.map((part, index) => {
            if (part.type === 'text') {
              const text = typeof part.text === 'string' ? part.text : String(part.text ?? '');
              if (!text) {
                return null;
              }
              return <MessageMarkdown key={`text-${index}`} isUser={isUser} text={text} />;
            }
            if (isToolUIPart(part)) {
              return (
                <div key={part.toolCallId} className="my-2">
                  {renderToolPart(part as ToolPart, toolCallStates)}
                </div>
              );
            }
            if (part.type === 'step-start') {
              // Only show divider for subsequent steps, not the first one.
              // Use findIndex instead of `index === 0` because data-* annotation
              // parts may precede the first step-start in v5's parts array.
              const firstStepStartIndex = messageParts.findIndex(p => p.type === 'step-start');
              if (index === firstStepStartIndex) {
                return null;
              }
              return (
                <div key={`step-${index}`} className="my-2 h-px w-full bg-black/10 dark:bg-white/10" />
              );
            }
            return null;
          })}


          {/* Streaming cursor */}
          {isStreamingThis && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current opacity-60" />
          )}
        </div>

        {/* ── Action bar (retry + variant nav) ── */}
        {showControls && (
          <div
            className={cn(
              // Hidden by default, revealed on hover of the entire message group.
              // Also visible whenever we have >1 variant (persistent affordance).
              'flex items-center gap-1.5 text-xs text-gray-400 transition-opacity duration-150 dark:text-gray-500',
              hasMultipleVariants
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {timestamp && <span className="mr-1 text-[11px] text-gray-400">{timestamp}</span>}

            <button
              type="button"
              onClick={() => void handleCopy()}
              title="Copy message"
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 hover:bg-gray-200/60 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>

            {!isUser && (
              <>
                {/* Retry / regenerate */}
                <button
                  type="button"
                  onClick={() => onRegenerate(message.id)}
                  disabled={isLoading || hasPendingToolInvocations}
                  title={hasPendingToolInvocations ? 'Wait for tool calls to finish' : 'Retry'}
                  className={cn(
                    'inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors',
                    isAssistantError
                      ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900'
                      : 'border-gray-300 hover:bg-gray-200/60 dark:border-gray-600 dark:hover:bg-gray-700',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry
                </button>

                {/* Variant navigator */}
                {hasMultipleVariants && (
                  <div
                    className="inline-flex items-center gap-0.5 rounded border border-gray-300 px-1 py-1 dark:border-gray-600"
                    title={`Response ${variantMeta.variantIndex + 1} of ${variantMeta.variantCount} — use arrows to switch`}
                  >
                    <button
                      type="button"
                      onClick={() => onSwitchVariant(variantMeta.turnKey, -1)}
                      disabled={isFirst || isLoading}
                      aria-label="Previous response variant"
                      className="rounded p-0.5 hover:bg-gray-200/60 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                    <span className="min-w-[2.5rem] text-center tabular-nums">
                      {variantMeta.variantIndex + 1}/{variantMeta.variantCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSwitchVariant(variantMeta.turnKey, 1)}
                      disabled={isLast || isLoading}
                      aria-label="Next response variant"
                      className="rounded p-0.5 hover:bg-gray-200/60 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Loading dots ──────────────────────────────────────────────

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'video', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    video: ['src', 'controls', 'autoPlay', 'loop', 'muted', 'playsInline', 'poster', 'preload', 'width', 'height', 'className', 'style'],
    source: ['src', 'type'],
  },
};

function MessageMarkdown({ text, isUser }: { text: string; isUser: boolean }) {
  return (
    <div className={cn('prose prose-sm max-w-none', isUser && 'prose-invert')}>
      <ReactMarkdown
        remarkPlugins={isUser ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          // Inline vs block code
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = Boolean(match);
            const raw = String(children ?? '');
            if (isBlock) {
              const lang = match?.[1] ?? 'text';
              return <CodeBlock code={raw.replace(/\n$/, '')} language={lang} />;
            }
            return (
              <code
                className="rounded bg-gray-200 px-1 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                {...props}
              >
                {children}
              </code>
            );
          },
          // Links
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-current underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          // Tables
          table: ({ children }) => (
            <div className="overflow-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700">
      <div className="flex items-center justify-between bg-gray-900 px-2 py-1 text-[11px] text-gray-300">
        <span>{language}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1000);
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-gray-700"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function LoadingDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

// ── Starter prompts ───────────────────────────────────────────

const STARTER_PROMPTS = [
  'Explain a complex topic',
  'Help me write code',
  'Analyze data',
  'Search the web',
  'Calculate something',
];
