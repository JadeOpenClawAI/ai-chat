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
  inputSchema?: unknown
}

type ThemePref = 'light' | 'dark' | 'system'

interface ToolParamRow {
  key: string
  depth: number
  type: string
  required: boolean
  description?: string
  note?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'))
}

function readType(node: Record<string, unknown>): string {
  const type = node.type
  return typeof type === 'string' ? type : 'string'
}

function readDescription(node: Record<string, unknown>): string | undefined {
  return typeof node.description === 'string' ? node.description : undefined
}

function readEnumNote(node: Record<string, unknown>): string | undefined {
  const values = node.enum
  if (!Array.isArray(values)) return undefined
  const strings = values.filter((entry): entry is string => typeof entry === 'string')
  return strings.length ? `enum: ${strings.join(' | ')}` : undefined
}

function readAdditionalPropertyType(value: unknown): string | null {
  if (value === undefined || value === null || value === false) return null
  if (value === true) return 'unknown'
  if (!isRecord(value)) return null
  const type = value.type
  return typeof type === 'string' ? type : 'unknown'
}

function collectObjectPropertiesRows(
  properties: Record<string, unknown>,
  parentPath: string,
  requiredSet: Set<string>,
  depth: number,
  rows: ToolParamRow[],
) {
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const path = parentPath ? `${parentPath}.${name}` : name
    collectParameterNodeRows(raw, path, requiredSet.has(name), depth, rows)
  }
}

function collectParameterNodeRows(
  node: Record<string, unknown>,
  path: string,
  required: boolean,
  depth: number,
  rows: ToolParamRow[],
) {
  const type = readType(node)
  const enumNote = readEnumNote(node)
  rows.push({
    key: path,
    depth,
    type,
    required,
    description: readDescription(node),
    note: enumNote,
  })

  if (type === 'object') {
    const properties = isRecord(node.properties) ? node.properties : null
    if (properties) {
      collectObjectPropertiesRows(properties, path, toStringSet(node.required), depth + 1, rows)
    }
    const additionalType = readAdditionalPropertyType(node.additionalProperties)
    if (additionalType) {
      rows.push({
        key: `${path}.*`,
        depth: depth + 1,
        type: additionalType,
        required: false,
        note: 'additional properties',
      })
    }
  }

  if (type === 'array') {
    const items = isRecord(node.items) ? node.items : null
    if (!items) return
    rows.push({
      key: `${path}[]`,
      depth: depth + 1,
      type: readType(items),
      required: false,
      note: 'array items',
    })
    if (readType(items) === 'object') {
      const itemProperties = isRecord(items.properties) ? items.properties : null
      if (itemProperties) {
        collectObjectPropertiesRows(itemProperties, `${path}[]`, toStringSet(items.required), depth + 2, rows)
      }
      const additionalType = readAdditionalPropertyType(items.additionalProperties)
      if (additionalType) {
        rows.push({
          key: `${path}[].*`,
          depth: depth + 2,
          type: additionalType,
          required: false,
          note: 'additional properties',
        })
      }
    }
  }
}

function getToolParameterRows(schema: unknown): ToolParamRow[] {
  if (!isRecord(schema)) return []

  if (schema.type === 'object' && isRecord(schema.properties)) {
    const rows: ToolParamRow[] = []
    collectObjectPropertiesRows(schema.properties, '', toStringSet(schema.required), 0, rows)
    return rows
  }

  const rows: ToolParamRow[] = []
  for (const [name, raw] of Object.entries(schema)) {
    if (!isRecord(raw)) continue
    collectParameterNodeRows(raw, name, raw.required === true, 0, rows)
  }
  return rows
}

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
    isAutoRouting,
    setIsAutoRouting,
    routeToast,
    routeToastKey,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    contextStats,
    contextPolicy,
    wasCompacted,
    compactionMode,
    toolCallStates,
    assistantVariantMeta,
    hiddenAssistantMessageIds,
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

    // Track current pref in a ref so the media/storage listeners stay fresh
    let currentPref = initial

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => {
      if (currentPref === 'system') apply('system')
    }
    media.addEventListener?.('change', onMedia)

    // Cross-tab sync: when another tab saves the theme, apply it here too
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== 'ai-chat:theme' || !ev.newValue) return
      const next = ev.newValue as ThemePref
      if (next !== 'light' && next !== 'dark' && next !== 'system') return
      currentPref = next
      setThemePref(next)
      apply(next)
    }
    window.addEventListener('storage', onStorage)

    return () => {
      media.removeEventListener?.('change', onMedia)
      window.removeEventListener('storage', onStorage)
    }
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
  const thresholdPercent = Math.round(contextPolicy.compactionThreshold * 100)
  const warningPercent = contextPolicy.mode === 'off' ? 90 : thresholdPercent
  const dangerPercent = contextPolicy.mode === 'off' ? 97 : Math.min(98, thresholdPercent + 15)
  const contextBarColor =
    contextPercent >= dangerPercent ? 'bg-red-500' : contextPercent >= warningPercent ? 'bg-yellow-500' : 'bg-blue-500'

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
              {compactionMode === 'truncate'
                ? 'Context truncated'
                : compactionMode === 'running-summary'
                  ? 'Context running summary'
                  : 'Context summarized'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            <input
              id="auto-routing-toggle"
              type="checkbox"
              checked={mounted ? isAutoRouting : true}
              onChange={(e) => setIsAutoRouting(e.target.checked)}
            />
            <label htmlFor="auto-routing-toggle" className="cursor-pointer select-none">
              Auto
            </label>
          </div>


          <div className="relative">
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              disabled={mounted ? isAutoRouting : true}
              className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-7 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
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
              disabled={mounted ? isAutoRouting : true}
              className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-7 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              {availableModels.map((m) => (
                <option key={m.provider + '/' +m.id} value={m.id}>
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
        {routeToast && (
          <div key={routeToastKey} className="mx-4 mt-2 overflow-hidden rounded border border-amber-300 bg-amber-50 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <div className="px-3 py-2">{routeToast}</div>
            <div className="h-0.5 w-full origin-right animate-toast-drain bg-amber-500/70 dark:bg-amber-300/70" />
          </div>
        )}
        <MessageList
          messages={messages}
          isLoading={isLoading}
          toolCallStates={toolCallStates}
          assistantVariantMeta={assistantVariantMeta}
          hiddenAssistantMessageIds={hiddenAssistantMessageIds}
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
            {contextPercent >= warningPercent && (
              <span className="text-yellow-500">
                {contextPolicy.mode === 'off'
                  ? '⚠ Approaching limit'
                  : `⚠ Compaction threshold (${thresholdPercent}%)`}
              </span>
            )}
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
              {toolsCatalog.map((tool) => {
                const paramRows = getToolParameterRows(tool.inputSchema)
                return (
                  <details key={tool.name} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                    <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                      {tool.icon} {tool.name} <span className="ml-2 text-xs text-gray-500">~{tool.expectedDurationMs}ms</span>
                    </summary>
                    <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{tool.description}</p>
                    <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                      <div>
                        <div className="mb-1 font-medium text-gray-500">Inputs</div>
                        {paramRows.length > 0 ? (
                          <div className="space-y-1">
                            {paramRows.map((row, idx) => (
                              <div key={`${tool.name}:${row.key}:${idx}`} className="rounded border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800/60">
                                <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: `${row.depth * 12}px` }}>
                                  <code className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{row.key}</code>
                                  <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-700 dark:bg-gray-700 dark:text-gray-200">{row.type}</span>
                                  <span className={cn(
                                    'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                                    row.required
                                      ? 'bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300'
                                      : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
                                  )}>
                                    {row.required ? 'required' : 'optional'}
                                  </span>
                                </div>
                                {(row.description || row.note) && (
                                  <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-300" style={{ paddingLeft: `${row.depth * 12}px` }}>
                                    {[row.description, row.note].filter(Boolean).join(' • ')}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <ul className="list-disc pl-4">
                            {tool.inputs.map((i) => <li key={i}>{i}</li>)}
                          </ul>
                        )}
                      </div>
                      <div>
                        <div className="mb-1 font-medium text-gray-500">Outputs</div>
                        <ul className="list-disc pl-4">
                          {tool.outputs.map((o) => <li key={o}>{o}</li>)}
                        </ul>
                      </div>
                    </div>
                  </details>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
