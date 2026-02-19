// ============================================================
// Message List Component
// Renders streaming messages with tool call progress
// ============================================================

'use client'

import { useEffect, useRef } from 'react'
import type { Message } from 'ai'
import type { ToolCallMeta } from '@/lib/types'
import { ToolCallProgress } from './ToolCallProgress'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { Bot, User, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'

interface MessageListProps {
  messages: Message[]
  isLoading: boolean
  toolCallStates: Record<string, ToolCallMeta>
  assistantVariantMeta: Record<string, { turnKey: string; variantIndex: number; variantCount: number }>
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void
  onRegenerate: (assistantMessageId: string) => void
}

export function MessageList({
  messages,
  isLoading,
  toolCallStates,
  assistantVariantMeta,
  onSwitchVariant,
  onRegenerate,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          toolCallStates={toolCallStates}
          variantMeta={assistantVariantMeta[message.id]}
          onSwitchVariant={onSwitchVariant}
          onRegenerate={onRegenerate}
        />
      ))}

      {/* Loading indicator */}
      {isLoading && (
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
  toolCallStates: Record<string, ToolCallMeta>
  variantMeta?: { turnKey: string; variantIndex: number; variantCount: number }
  onSwitchVariant: (turnKey: string, direction: -1 | 1) => void
  onRegenerate: (assistantMessageId: string) => void
}

function MessageBubble({ message, toolCallStates, variantMeta, onSwitchVariant, onRegenerate }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isAssistantError = !isUser && typeof message.content === 'string' && message.content.startsWith('❌ Error:')

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="rounded-full border border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400">
          📋 {message.content}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3',
        isUser && 'flex-row-reverse',
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm',
          isUser
            ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
            : 'bg-gray-200 dark:bg-gray-700',
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4 text-gray-500" />
        )}
      </div>

      {/* Content */}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-3',
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

        {/* Text content */}
        {message.content && (
          <div className={cn('prose prose-sm max-w-none', isUser && 'prose-invert')}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Inline code
                code: ({ className, children, ...props }) => {
                  const isBlock = className?.includes('language-')
                  if (isBlock) {
                    return (
                      <pre className="overflow-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100 dark:bg-black">
                        <code className={className} {...props}>
                          {children}
                        </code>
                      </pre>
                    )
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
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Tool invocations */}
        {message.toolInvocations && message.toolInvocations.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.toolInvocations.map((ti) => {
              const trackedState = toolCallStates[ti.toolCallId]
              const meta: ToolCallMeta = trackedState ?? {
                toolCallId: ti.toolCallId,
                toolName: ti.toolName,
                state: ti.state === 'result' ? 'done' : 'running',
              }

              return (
                <ToolCallProgress
                  key={ti.toolCallId}
                  toolCall={meta}
                  result={
                    ti.state === 'result'
                      ? typeof ti.result === 'string'
                        ? ti.result
                        : JSON.stringify(ti.result, null, 2)
                      : undefined
                  }
                />
              )
            })}
          </div>
        )}

        {!isUser && !isSystem && (
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <button
              type="button"
              onClick={() => onRegenerate(message.id)}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 hover:bg-gray-200/60 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              <RotateCcw className="h-3 w-3" /> Retry
            </button>

            {variantMeta && variantMeta.variantCount > 1 && (
              <div className="inline-flex items-center gap-1 rounded border border-gray-300 px-1 py-1 dark:border-gray-600">
                <button
                  type="button"
                  onClick={() => onSwitchVariant(variantMeta.turnKey, -1)}
                  disabled={variantMeta.variantIndex === 0}
                  className="rounded p-0.5 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3 w-3" />
                </button>
                <span className="px-1">{variantMeta.variantIndex + 1}/{variantMeta.variantCount}</span>
                <button
                  type="button"
                  onClick={() => onSwitchVariant(variantMeta.turnKey, 1)}
                  disabled={variantMeta.variantIndex >= variantMeta.variantCount - 1}
                  className="rounded p-0.5 disabled:opacity-40"
                >
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Loading dots ──────────────────────────────────────────────

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
