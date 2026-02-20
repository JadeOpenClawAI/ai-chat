'use client'

import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import Link from 'next/link'
import { useChat } from '@/hooks/useChat'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { MODEL_OPTIONS } from '@/lib/types'
import { formatTokens, cn } from '@/lib/utils'
import { Trash2, ChevronDown, Zap, Info, Settings, X, Sun, Moon, Monitor } from 'lucide-react'

interface ToolCatalogItem {
  name: string
  description: string
  icon: string
  expectedDurationMs: number
  inputs: string[]
  outputs: string[]
}

type ThemePref = 'light' | 'dark' | 'system'

export function ChatInterface() {
  const {
    messages,
    input,
    setInput,
    setInputValue,
    isLoading,
    stop,
    sendMessage,
    clearConversation,
    profileId,
    setProfileId,
    profiles,
    availableModelsForProfile,
    model,
    setModel,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    contextStats,
    wasCompacted,
    toolCallStates,
    assistantVariantMeta,
    switchAssistantVariant,
    regenerateAssistantAt,
  } = useChat()

  const handleSend = useCallback(async () => {
    const val =
      typeof input === 'string'
        ? input
        : (input as unknown as { target: { value: string } })?.target?.value ?? ''
    if (!val.trim() && pendingAttachments.length === 0) return
    setInputValue('')
    await sendMessage(val)
  }, [input, pendingAttachments, sendMessage, setInputValue])

  const availableModels = (() => {
    if (availableModelsForProfile.length === 0) return MODEL_OPTIONS
    const known = MODEL_OPTIONS.filter((m) => availableModelsForProfile.includes(m.id))
    const knownIds = new Set(known.map((m) => m.id))
    const custom = availableModelsForProfile
      .filter((id) => !knownIds.has(id))
      .map((id) => ({
        id,
        name: id,
        provider: 'custom' as const,
        contextWindow: 200000,
        supportsVision: false,
        supportsTools: true,
      }))
    return [...known, ...custom]
  })()

  const [mounted, setMounted] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsCatalog, setToolsCatalog] = useState<ToolCatalogItem[]>([])
  const [themePref, setThemePref] = useState<ThemePref>('system')

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = (pref: ThemePref) => {
      const root = document.documentElement
      const isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      root.classList.toggle('dark', isDark)
    }

    const stored = window.localStorage.getItem('ai-chat:theme') as ThemePref | null
    const initial: ThemePref = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
    setThemePref(initial)
    apply(initial)

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => {
      if (initial === 'system') apply('system')
    }
    media.addEventListener?.('change', onMedia)
    return () => media.removeEventListener?.('change', onMedia)
  }, [])

  const cycleTheme = useCallback(() => {
    const next: ThemePref = themePref === 'light' ? 'dark' : themePref === 'dark' ? 'system' : 'light'
    setThemePref(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('ai-chat:theme', next)
      const isDark = next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', isDark)
    }
  }, [themePref])

  useEffect(() => {
    if (!toolsOpen) return
    void (async () => {
      const res = await fetch('/api/tools')
      const data = (await res.json()) as { tools: ToolCatalogItem[] }
      setToolsCatalog(data.tools ?? [])
    })()
  }, [toolsOpen])

  const selectedModel = availableModels.find((m) => m.id === model)
  const contextPercent = Math.round(contextStats.percentage * 100)
  const contextBarColor =
    contextPercent >= 90 ? 'bg-red-500' : contextPercent >= 70 ? 'bg-yellow-500' : 'bg-blue-500'

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-gray-950">
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
          <div className="relative">
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-7 text-xs text-gray-700 outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              title="Active profile"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          </div>

          <div className="relative">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-7 text-xs text-gray-700 outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          </div>

          <button
            onClick={clearConversation}
            disabled={messages.length === 0}
            title="Clear conversation"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={cycleTheme}
            title={`Theme: ${themePref} (click to cycle)`}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            {themePref === 'light' ? <Sun className="h-4 w-4" /> : themePref === 'dark' ? <Moon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
          </button>

          <Link
            href="/settings"
            title="Settings"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden">
        <MessageList
          messages={messages}
          isLoading={isLoading}
          toolCallStates={toolCallStates}
          assistantVariantMeta={assistantVariantMeta}
          onSwitchVariant={switchAssistantVariant}
          onRegenerate={(assistantMessageId) => regenerateAssistantAt(assistantMessageId, model)}
        />
      </div>


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

        <div className="mt-2 flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className={cn('h-full rounded-full transition-all', contextBarColor)}
                  style={{ width: `${Math.min(contextPercent, 100)}%` }}
                />
              </div>
              <span>
                Context: {formatTokens(contextStats.used)} / {formatTokens(contextStats.limit)} tokens
              </span>
            </div>
            {contextPercent >= 80 && <span className="text-yellow-500">⚠ Approaching limit</span>}
          </div>

          <div className="flex items-center gap-3">
            {mounted && selectedModel && (
              <>
                {selectedModel.supportsVision && <span>👁 Vision</span>}
                {selectedModel.supportsVision && selectedModel.supportsTools && <span className="mx-1">·</span>}
                {selectedModel.supportsTools && (
                  <button
                    type="button"
                    onClick={() => setToolsOpen(true)}
                    className="rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    🔧 Tools
                  </button>
                )}
              </>
            )}
            <span className="flex items-center gap-1">
              <Info className="h-3 w-3" />
              Shift+Enter for newline
            </span>
          </div>
        </div>
      </div>

      {toolsOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => setToolsOpen(false)}>
          <div
            className="max-h-[75vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-4 text-gray-900 shadow-2xl dark:bg-gray-900 dark:text-gray-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Available Tools</h3>
              <button type="button" onClick={() => setToolsOpen(false)} className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2">
              {toolsCatalog.map((tool) => (
                <details key={tool.name} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                  <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                    {tool.icon} {tool.name} <span className="ml-2 text-xs text-gray-500">~{tool.expectedDurationMs}ms</span>
                  </summary>
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{tool.description}</p>
                  <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                    <div>
                      <div className="mb-1 font-medium text-gray-500">Inputs</div>
                      <ul className="list-disc pl-4">
                        {tool.inputs.map((i) => <li key={i}>{i}</li>)}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-1 font-medium text-gray-500">Outputs</div>
                      <ul className="list-disc pl-4">
                        {tool.outputs.map((o) => <li key={o}>{o}</li>)}
                      </ul>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
