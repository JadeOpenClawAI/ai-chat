// ============================================================
// Message List Component
// Renders streaming messages with tool call progress, variant
// navigation, and retry/regenerate affordances.
// ============================================================

'use client'

import { useEffect, useRef, useState } from 'react'
import type { Message, ToolInvocation } from 'ai'
import type { ToolCallMeta } from '@/lib/types'
import { ToolCallProgress } from './ToolCallProgress'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { Bot, User, ChevronLeft, ChevronRight, RotateCcw, AlertTriangle, Copy, Check } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

interface MessageListProps {
  messages: Message[]
  isLoading: boolean
  toolCallStates: Record<string, ToolCallMeta>
  assistantVariantMeta: Record<string, { turnKey: string; variantIndex: number; variantCount: number }>
  hiddenAssistantMessageIds?: string[]
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void
  onRegenerate: (assistantMessageId: string) => void
}

function stringifyWithLimit(value: unknown, maxChars = 4000): string {
  try {
    const raw = JSON.stringify(value, null, 2)
    if (raw.length <= maxChars) return raw
    return `${raw.slice(0, maxChars)}\n... (truncated ${raw.length - maxChars} chars)`
  } catch {
    return String(value)
  }
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const isCompactionSummarySystemMessage = (message: Message) =>
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.startsWith('[Conversation Summary]')

  // Auto-scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

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
    )
  }

  const filteredMessages = messages.filter((m) => {
    if (m.role === 'assistant' && hiddenAssistantMessageIds.includes(m.id)) return false
    if (isCompactionSummarySystemMessage(m)) return false
    return true
  })
  const lastMessageId = filteredMessages[filteredMessages.length - 1]?.id

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
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
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
            <Bot className="h-4 w-4 text-gray-500" />
          </div>
          <div className="rounded-2xl rounded-tl-none bg-gray-100 px-4 py-3 dark:bg-gray-800">
            <LoadingDots />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

// ── Message Bubble ────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message
  isLoading: boolean
  isStreamingThis: boolean
  toolCallStates: Record<string, ToolCallMeta>
  variantMeta?: { turnKey: string; variantIndex: number; variantCount: number }
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void
  onRegenerate: (assistantMessageId: string) => void
}

type MessagePart = NonNullable<Message['parts']>[number]

function getMessageParts(message: Message): MessagePart[] {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts as MessagePart[]
  }
  const parts: MessagePart[] = []
  if (Array.isArray(message.toolInvocations)) {
    for (const toolInvocation of message.toolInvocations) {
      parts.push({ type: 'tool-invocation', toolInvocation } as MessagePart)
    }
  }
  if (typeof message.content === 'string' && message.content.length > 0) {
    parts.push({ type: 'text', text: message.content } as MessagePart)
  }
  return parts
}

function getMessageText(message: Message): string {
  const parts = getMessageParts(message)
  const text = parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
  if (text.length > 0) return text
  return typeof message.content === 'string' ? message.content : ''
}

function getToolInvocationsFromParts(parts: MessagePart[]): ToolInvocation[] {
  const toolInvocations: ToolInvocation[] = []
  for (const part of parts) {
    if (part.type === 'tool-invocation') {
      toolInvocations.push(part.toolInvocation)
    }
  }
  return toolInvocations
}

function renderToolInvocation(
  toolInvocation: ToolInvocation,
  toolCallStates: Record<string, ToolCallMeta>,
) {
  const trackedState = toolCallStates[toolInvocation.toolCallId]
  const fallbackError =
    toolInvocation.state === 'result' && (
      (typeof toolInvocation.result === 'string' && toolInvocation.result.toLowerCase().includes('error')) ||
      (typeof toolInvocation.result === 'object' &&
        toolInvocation.result !== null &&
        typeof (toolInvocation.result as { error?: unknown }).error === 'string')
    )
      ? (typeof toolInvocation.result === 'string'
          ? toolInvocation.result
          : String((toolInvocation.result as { error?: unknown }).error))
      : undefined
  const meta: ToolCallMeta = trackedState ?? {
    toolCallId: toolInvocation.toolCallId,
    toolName: toolInvocation.toolName,
    state:
      fallbackError
        ? 'error'
        : toolInvocation.state === 'partial-call'
          ? 'streaming'
          : (toolInvocation.state === 'result' ? 'done' : 'running'),
    error: fallbackError,
  }
  const input =
    toolInvocation.state === 'partial-call'
      ? 'Building tool arguments...'
      : (toolInvocation.args ? stringifyWithLimit(toolInvocation.args) : undefined)

  return (
    <ToolCallProgress
      toolCall={meta}
      input={input}
      output={
        toolInvocation.state === 'result'
          ? typeof toolInvocation.result === 'string'
            ? toolInvocation.result
            : JSON.stringify(toolInvocation.result, null, 2)
          : undefined
      }
    />
  )
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
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isAssistantError = !isUser && typeof message.content === 'string' && message.content.startsWith('❌ Error:')
  const messageParts = getMessageParts(message)
  const messageToolInvocations = getToolInvocationsFromParts(messageParts)

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="rounded-full border border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400">
          📋 {message.content}
        </div>
      </div>
    )
  }

  // Controls are shown below each assistant bubble.
  // • While this specific message is still streaming → hide (not finalised yet)
  // • While any message is loading → disable but still show for non-streaming messages
  const showControls = !isSystem && !isStreamingThis
  const hasMultipleVariants = variantMeta && variantMeta.variantCount > 1
  const isFirst = variantMeta ? variantMeta.variantIndex === 0 : true
  const isLast = variantMeta ? variantMeta.variantIndex >= variantMeta.variantCount - 1 : true
  const hasPendingToolInvocations =
    !isUser &&
    messageToolInvocations.some((ti) => ti.state !== 'result')

  const timestampRaw = (message as { createdAt?: string | Date }).createdAt
  const timestamp = timestampRaw
    ? new Date(timestampRaw).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const handleCopy = async () => {
    const text = getMessageText(message)
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

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
              : 'bg-gray-200 dark:bg-gray-700',
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : isAssistantError ? (
          <AlertTriangle className="h-4 w-4 text-red-500 dark:text-red-400" />
        ) : (
          <Bot className="h-4 w-4 text-gray-500" />
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
                : 'rounded-tl-none bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100',
          )}
        >
          {/* Image attachments */}
          {message.experimental_attachments &&
            message.experimental_attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {message.experimental_attachments
                  .filter((a) => a.contentType?.startsWith('image/'))
                  .map((a, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={a.url}
                      alt={a.name ?? 'attached image'}
                      className="max-h-48 max-w-full rounded-lg object-cover"
                    />
                  ))}
              </div>
            )}

          {/* Ordered message parts (text/tool/step) */}
          {messageParts.map((part, index) => {
            if (part.type === 'text') {
              if (!part.text) return null
              return <MessageMarkdown key={`text-${index}`} isUser={isUser} text={part.text} />
            }
            if (part.type === 'tool-invocation') {
              return (
                <div key={part.toolInvocation.toolCallId} className="my-2">
                  {renderToolInvocation(part.toolInvocation, toolCallStates)}
                </div>
              )
            }
            if (part.type === 'step-start') {
              if (index === 0) return null
              // Visual separator between pre-tool and post-tool assistant text.
              return (
                <div key={`step-${index}`} className="my-2 h-px w-full bg-black/10 dark:bg-white/10" />
              )
            }
            return null
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
  )
}

// ── Loading dots ──────────────────────────────────────────────

function MessageMarkdown({ text, isUser }: { text: string; isUser: boolean }) {
  return (
    <div className={cn('prose prose-sm max-w-none', isUser && 'prose-invert')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Inline vs block code
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '')
            const isBlock = Boolean(match)
            const raw = String(children ?? '')
            if (isBlock) {
              const lang = match?.[1] ?? 'text'
              return <CodeBlock code={raw.replace(/\n$/, '')} language={lang} />
            }
            return (
              <code
                className="rounded bg-gray-200 px-1 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                {...props}
              >
                {children}
              </code>
            )
          },
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
  )
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700">
      <div className="flex items-center justify-between bg-gray-900 px-2 py-1 text-[11px] text-gray-300">
        <span>{language}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1000)
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
  )
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
  )
}

// ── Starter prompts ───────────────────────────────────────────

const STARTER_PROMPTS = [
  'Explain a complex topic',
  'Help me write code',
  'Analyze data',
  'Search the web',
  'Calculate something',
]
