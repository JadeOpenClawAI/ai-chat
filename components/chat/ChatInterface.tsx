// ============================================================
// ChatInterface — main chat UI component
// Combines MessageList + MessageInput + context stats bar
// ============================================================

'use client'

import { useCallback, type ChangeEvent } from 'react'
import { useChat } from '@/hooks/useChat'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { MODEL_OPTIONS } from '@/lib/types'
import { formatTokens } from '@/lib/utils'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import {
  Trash2,
  ChevronDown,
  Zap,
  Info,
  Settings,
} from 'lucide-react'

export function ChatInterface() {
  const {
    messages,
    input,
    setInput,
    isLoading,
    stop,
    error,
    sendMessage,
    clearConversation,
    provider,
    setProvider,
    model,
    setModel,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    contextStats,
    wasCompacted,
    toolCallStates,
  } = useChat()

  const handleSend = useCallback(async () => {
    const val = typeof input === 'string' ? input : (input as unknown as { target: { value: string } })?.target?.value ?? ''
    if (!val.trim() && pendingAttachments.length === 0) return
    await sendMessage(val)
  }, [input, pendingAttachments, sendMessage])

  // MODEL_OPTIONS filtered to available providers
  const availableModels = MODEL_OPTIONS

  const selectedModel = availableModels.find((m) => m.id === model)

  const contextPercent = Math.round(contextStats.percentage * 100)
  const contextBarColor =
    contextPercent >= 90
      ? 'bg-red-500'
      : contextPercent >= 70
        ? 'bg-yellow-500'
        : 'bg-blue-500'

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-gray-950">
      {/* ── Top bar ──────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {process.env.NEXT_PUBLIC_APP_NAME ?? 'AI Chat'}
          </h1>
          {wasCompacted && (
            <span className="flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">
              <Zap className="h-3 w-3" />
              Context summarized
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Model selector */}
          <div className="relative">
            <select
              value={model}
              onChange={(e) => {
                const selected = availableModels.find(
                  (m) => m.id === e.target.value,
                )
                if (selected) {
                  setModel(selected.id)
                  setProvider(selected.provider)
                }
              }}
              className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-7 text-xs text-gray-700 outline-none hover:border-gray-300 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          </div>

          {/* Clear conversation */}
          <button
            onClick={clearConversation}
            disabled={messages.length === 0}
            title="Clear conversation"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          {/* Settings */}
          <Link
            href="/settings"
            title="Settings"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </header>

      {/* ── Messages ─────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={isLoading}
          toolCallStates={toolCallStates}
        />
      </div>

      {/* ── Error banner ─────────────────────────────────────── */}
      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          <strong>Error:</strong> {error.message}
        </div>
      )}

      {/* ── Input area ───────────────────────────────────────── */}
      <div className="border-t border-gray-100 px-4 pb-4 pt-2 dark:border-gray-800">
        <MessageInput
          value={typeof input === 'string' ? input : ''}
          onChange={setInput as (e: ChangeEvent<HTMLTextAreaElement>) => void}
          onSend={handleSend}
          onStop={stop}
          isLoading={isLoading}
          pendingAttachments={pendingAttachments}
          onAddAttachment={addAttachment}
          onRemoveAttachment={removeAttachment}
        />

        {/* ── Context stats bar ─────────────────────────────── */}
        <div className="mt-2 flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    contextBarColor,
                  )}
                  style={{ width: `${Math.min(contextPercent, 100)}%` }}
                />
              </div>
              <span>
                Context: {formatTokens(contextStats.used)} /{' '}
                {formatTokens(contextStats.limit)} tokens
              </span>
            </div>
            {contextPercent >= 80 && (
              <span className="text-yellow-500">
                ⚠ Approaching limit
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {selectedModel && (
              <span>
                {selectedModel.supportsVision ? '👁 Vision' : ''}{' '}
                {selectedModel.supportsTools ? '🔧 Tools' : ''}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Info className="h-3 w-3" />
              Shift+Enter for newline
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
