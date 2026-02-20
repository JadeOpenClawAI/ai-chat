'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppConfig,
  ContextManagementPolicy,
  ProfileConfig,
  RouteTarget,
  ToolCompactionPolicy,
} from '@/lib/config/store'
import type { LLMProvider } from '@/lib/types'

type View = 'list' | 'add-choose' | 'add-form' | 'edit'

const PROVIDER_OPTIONS: { value: LLMProvider; label: string; description: string }[] = [
  { value: 'anthropic', label: 'Claude API', description: 'Anthropic Claude models via API key' },
  { value: 'anthropic-oauth', label: 'Claude OAuth', description: 'Anthropic Claude models via one-click OAuth connect' },
  { value: 'openai', label: 'OpenAI API', description: 'OpenAI models via API key' },
  { value: 'codex', label: 'OpenAI Codex OAuth', description: 'Codex models via OAuth (one-click connect)' },
]

const DEFAULT_MODELS: Record<LLMProvider, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  'anthropic-oauth': ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  codex: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'],
}

const FIELD_CLASS = 'w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100'
const SMALL_FIELD_CLASS = 'rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100'

const CONTEXT_MODE_OPTIONS: Array<{ value: ContextManagementPolicy['mode']; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'No automatic compaction.' },
  { value: 'truncate', label: 'Truncate', hint: 'Drop oldest messages to fit budget.' },
  { value: 'summary', label: 'AI Summary', hint: 'Summarize old history on threshold.' },
  { value: 'running-summary', label: 'Running Summary', hint: 'Maintain and refresh rolling summary.' },
]

const TOOL_COMPACTION_MODE_OPTIONS: Array<{ value: ToolCompactionPolicy['mode']; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'Never compact tool results.' },
  { value: 'summary', label: 'AI Summary', hint: 'Summarize large tool results with the model.' },
  { value: 'truncate', label: 'Truncate', hint: 'Cut large tool results without AI summarization.' },
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hasStoredSecret(value?: string) {
  return value === '***' || !!value
}

function makeNewProfile(provider: LLMProvider): ProfileConfig {
  return {
    id: provider === 'codex' || provider === 'anthropic-oauth' ? `${provider}:oauth` : `${provider}:default`,
    provider,
    displayName: '',
    enabled: true,
    allowedModels: [...DEFAULT_MODELS[provider]],
    systemPrompts: [],
  }
}

/* ─── Model Priority Editor ─── */

function ModelPriorityEditor({
  modelPriority,
  profiles,
  onChange,
}: {
  modelPriority: RouteTarget[]
  profiles: ProfileConfig[]
  onChange: (mp: RouteTarget[]) => void
}) {
  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragIdx = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  // Build all possible profile:model combos from enabled profiles
  const allOptions = useMemo(() => {
    const opts: string[] = []
    for (const p of profiles) {
      if (!p.enabled) continue
      for (const m of p.allowedModels) {
        opts.push(`${p.id}/${m}`)
      }
    }
    return opts
  }, [profiles])

  // Filter suggestions based on input
  const suggestions = useMemo(() => {
    if (!input.trim()) return allOptions
    const lower = input.toLowerCase()
    return allOptions.filter((o) => o.toLowerCase().includes(lower))
  }, [input, allOptions])

  // Already-added set for dedup display
  const addedSet = useMemo(() => {
    const s = new Set<string>()
    for (const t of modelPriority) s.add(`${t.profileId}/${t.modelId}`)
    return s
  }, [modelPriority])

  const addEntry = useCallback((option: string) => {
    const [profileId, modelId] = option.split('/')
    if (!profileId || !modelId) return
    // Don't add duplicates
    if (modelPriority.some((t) => t.profileId === profileId && t.modelId === modelId)) return
    onChange([...modelPriority, { profileId, modelId }])
    setInput('')
    setShowSuggestions(false)
    inputRef.current?.focus()
  }, [modelPriority, onChange])

  const removeEntry = useCallback((idx: number) => {
    onChange(modelPriority.filter((_, i) => i !== idx))
  }, [modelPriority, onChange])

  // Drag reorder
  const handleDragStart = useCallback((idx: number) => {
    dragIdx.current = idx
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    setDragOverIdx(idx)
  }, [])

  const handleDrop = useCallback((idx: number) => {
    if (dragIdx.current === null || dragIdx.current === idx) {
      dragIdx.current = null
      setDragOverIdx(null)
      return
    }
    const items = [...modelPriority]
    const [moved] = items.splice(dragIdx.current, 1)
    items.splice(idx, 0, moved)
    onChange(items)
    dragIdx.current = null
    setDragOverIdx(null)
  }, [modelPriority, onChange])

  return (
    <div className="space-y-2">
      {/* Priority bubbles */}
      <div className="flex flex-wrap gap-2">
        {modelPriority.map((t, i) => {
          const label = `${t.profileId}/${t.modelId}`
          const isFirst = i === 0
          return (
            <div
              key={label}
              draggable
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={() => handleDrop(i)}
              className={`flex cursor-grab items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                dragOverIdx === i
                  ? 'ring-2 ring-blue-400'
                  : isFirst
                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {isFirst && <span className="mr-0.5 text-[10px]">★</span>}
              <span className="select-none">{label}</span>
              <button
                onClick={() => removeEntry(i)}
                className="ml-1 rounded-full text-[10px] opacity-60 hover:opacity-100"
                title="Remove"
              >
                ✕
              </button>
            </div>
          )
        })}
        {modelPriority.length === 0 && (
          <p className="text-xs text-gray-400">No models added yet. Type below to add one.</p>
        )}
      </div>

      {/* Autocomplete input */}
      <div className="relative">
        <input
          ref={inputRef}
          className={FIELD_CLASS}
          placeholder="Type to add a model (e.g. anthropic:default/claude-sonnet-4-5)"
          value={input}
          onChange={(e) => { setInput(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const notAdded = suggestions.filter((s) => !addedSet.has(s))
              if (notAdded[0]) addEntry(notAdded[0])
            }
          }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {suggestions.map((opt) => {
              const added = addedSet.has(opt)
              return (
                <button
                  key={opt}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800 ${added ? 'opacity-40' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); if (!added) addEntry(opt) }}
                  disabled={added}
                >
                  <span>{opt}</span>
                  {added && <span className="text-[10px] text-gray-400">added</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <p className="text-[11px] text-gray-400">
        ★ First item is the primary model. Drag to reorder. Fallbacks are tried in order if primary fails.
      </p>
    </div>
  )
}

/* ─── Settings Page ─── */

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [view, setView] = useState<View>('list')
  const [editing, setEditing] = useState<ProfileConfig | null>(null)
  const [routingBaseline, setRoutingBaseline] = useState('')
  const [contextManagementBaseline, setContextManagementBaseline] = useState('')
  const [toolCompactionBaseline, setToolCompactionBaseline] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [customModelInput, setCustomModelInput] = useState('')
  const [editingBaseline, setEditingBaseline] = useState('')
  const [editingOriginalId, setEditingOriginalId] = useState('')
  const [headerDraftKey, setHeaderDraftKey] = useState('')
  const [headerDraftValue, setHeaderDraftValue] = useState('')
  const [codexAuthState, setCodexAuthState] = useState<Record<string, 'ok' | 'expired' | 'unknown' | 'disconnected'>>({})
  const [anthropicAuthState, setAnthropicAuthState] = useState<Record<string, 'ok' | 'expired' | 'unknown' | 'disconnected'>>({})
  const loadInFlightRef = useRef(false)
  const hasUnsavedSettingsRef = useRef(false)

  const load = useCallback(async (options?: { force?: boolean }) => {
    const shouldForce = options?.force === true
    if (!shouldForce && hasUnsavedSettingsRef.current) return
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    try {
      const res = await fetch('/api/settings')
      const data = (await res.json()) as { config: AppConfig }
      setConfig(data.config)
      setRoutingBaseline(JSON.stringify(data.config.routing.modelPriority))
      setContextManagementBaseline(JSON.stringify(data.config.contextManagement))
      setToolCompactionBaseline(JSON.stringify(data.config.toolCompaction))

      const codexProfiles = data.config.profiles.filter((p) => p.provider === 'codex')
      const codexStatusEntries = await Promise.all(
        codexProfiles.map(async (p) => {
          try {
            const r = await fetch('/api/settings/codex-oauth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'status', profileId: p.id }),
            })
            const j = (await r.json()) as { connected?: boolean }
            return [p.id, j.connected ? 'ok' : 'disconnected'] as const
          } catch {
            return [p.id, 'unknown'] as const
          }
        }),
      )
      const nextCodexAuthState: Record<string, 'ok' | 'expired' | 'unknown' | 'disconnected'> = {}
      for (const [profileId, state] of codexStatusEntries) {
        nextCodexAuthState[profileId] = state
      }
      setCodexAuthState(nextCodexAuthState)

      const anthropicProfiles = data.config.profiles.filter((p) => p.provider === 'anthropic-oauth')
      const anthropicStatusEntries = await Promise.all(
        anthropicProfiles.map(async (p) => {
          try {
            const r = await fetch('/api/settings/anthropic-oauth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'status', profileId: p.id }),
            })
            const j = (await r.json()) as { connected?: boolean }
            return [p.id, j.connected ? 'ok' : 'disconnected'] as const
          } catch {
            return [p.id, 'unknown'] as const
          }
        }),
      )
      const nextAnthropicAuthState: Record<string, 'ok' | 'expired' | 'unknown' | 'disconnected'> = {}
      for (const [profileId, state] of anthropicStatusEntries) {
        nextAnthropicAuthState[profileId] = state
      }
      setAnthropicAuthState(nextAnthropicAuthState)
    } finally {
      loadInFlightRef.current = false
    }
  }, [])

  useEffect(() => { void load({ force: true }) }, [load])

  useEffect(() => {
    const onFocus = () => { void load() }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const oauthError = params.get('oauth_error')
    const oauthProvider = params.get('oauth_provider')
    if (connected === 'codex') {
      setSuccess('✅ Codex OAuth connected successfully')
      setError('')
      window.history.replaceState({}, '', '/settings')
    } else if (connected === 'anthropic-oauth' || connected === 'anthropic') {
      setSuccess('✅ Anthropic OAuth connected successfully')
      setError('')
      window.history.replaceState({}, '', '/settings')
    } else if (oauthError) {
      const providerLabel = oauthProvider === 'anthropic-oauth' || oauthProvider === 'anthropic' ? 'Anthropic' : 'Codex'
      setError(`${providerLabel} OAuth error: ${oauthError}`)
      setSuccess('')
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  const hasUnsavedProfileChanges = (view === 'add-form' || view === 'edit')
    && editing !== null
    && JSON.stringify(editing) !== editingBaseline
  const hasUnsavedRoutingChanges = view === 'list'
    && routingBaseline.length > 0
    && config !== null
    && JSON.stringify(config.routing.modelPriority) !== routingBaseline
  const hasUnsavedContextManagementChanges = view === 'list'
    && contextManagementBaseline.length > 0
    && config !== null
    && JSON.stringify(config.contextManagement) !== contextManagementBaseline
  const hasUnsavedToolCompactionChanges = view === 'list'
    && toolCompactionBaseline.length > 0
    && config !== null
    && JSON.stringify(config.toolCompaction) !== toolCompactionBaseline
  const hasUnsavedSettingsChanges = hasUnsavedProfileChanges
    || hasUnsavedRoutingChanges
    || hasUnsavedContextManagementChanges
    || hasUnsavedToolCompactionChanges

  useEffect(() => {
    hasUnsavedSettingsRef.current = hasUnsavedSettingsChanges
    ;(window as typeof window & { __settingsHasUnsaved?: boolean; __settingsHasUnsavedProfile?: boolean }).__settingsHasUnsaved = hasUnsavedSettingsChanges
    ;(window as typeof window & { __settingsHasUnsaved?: boolean; __settingsHasUnsavedProfile?: boolean }).__settingsHasUnsavedProfile = hasUnsavedProfileChanges

    if (!hasUnsavedSettingsChanges) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      ;(window as typeof window & { __settingsHasUnsaved?: boolean; __settingsHasUnsavedProfile?: boolean }).__settingsHasUnsaved = false
      ;(window as typeof window & { __settingsHasUnsaved?: boolean; __settingsHasUnsavedProfile?: boolean }).__settingsHasUnsavedProfile = false
    }
  }, [hasUnsavedProfileChanges, hasUnsavedSettingsChanges])

  if (!config) return <div className="p-6 text-sm text-gray-500">Loading…</div>

  function startAdd() {
    setView('add-choose')
    setEditing(null)
    setShowAdvanced(false)
    setCustomModelInput('')
    setHeaderDraftKey('')
    setHeaderDraftValue('')
    setError('')
    setSuccess('')
  }

  function chooseProvider(provider: LLMProvider) {
    const p = makeNewProfile(provider)
    setEditing(p)
    setEditingBaseline(JSON.stringify(p))
    setEditingOriginalId('')
    setView('add-form')
    setShowAdvanced(false)
    setCustomModelInput('')
    setHeaderDraftKey('')
    setHeaderDraftValue('')
  }

  function startEdit(profile: ProfileConfig) {
    const p = { ...profile }
    setEditing(p)
    setEditingBaseline(JSON.stringify(p))
    setEditingOriginalId(profile.id)
    setView('edit')
    setShowAdvanced(false)
    setCustomModelInput('')
    setHeaderDraftKey('')
    setHeaderDraftValue('')
    setError('')
    setSuccess('')
  }

  function back() {
    if (hasUnsavedProfileChanges && !confirm('You have unsaved profile changes. Discard them?')) return
    setView('list')
    setEditing(null)
    setEditingBaseline('')
    setEditingOriginalId('')
    setCustomModelInput('')
    setHeaderDraftKey('')
    setHeaderDraftValue('')
    setError('')
    setSuccess('')
  }

  async function saveProfile() {
    if (!config || !editing) return
    if (!editing.id || !editing.id.match(/^(anthropic|anthropic-oauth|openai|codex):[a-zA-Z0-9._-]+$/)) {
      setError('Profile ID must be provider:name format (e.g. anthropic:my-key)')
      return
    }
    setSaving(true)
    setError('')
    try {
      const isNew = view === 'add-form'
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isNew ? 'profile-create' : 'profile-update',
          profile: editing,
          originalProfileId: isNew ? undefined : editingOriginalId,
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save')
        return
      }
      setSuccess('Profile saved!')
      setEditingBaseline(JSON.stringify(editing))
      setEditingOriginalId(editing.id)
      await load({ force: true })
      setTimeout(() => setSuccess(''), 1500)
    } finally {
      setSaving(false)
    }
  }

  async function deleteProfile(id: string) {
    if (!confirm(`Delete profile "${id}"?`)) return
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'profile-delete', profileId: id }),
    })
    await load({ force: true })
  }

  async function saveRouting(modelPriority: RouteTarget[]) {
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'routing-update',
          routing: { ...config.routing, modelPriority },
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) setError(data.error ?? 'Failed to save routing')
      else { setSuccess('Routing saved!'); await load({ force: true }); setTimeout(() => setSuccess(''), 2000) }
    } finally {
      setSaving(false)
    }
  }

  async function saveContextManagement(contextManagement: ContextManagementPolicy) {
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'context-management-update',
          contextManagement,
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save context settings')
        return
      }
      setSuccess('Context settings saved!')
      await load({ force: true })
      setTimeout(() => setSuccess(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  async function saveToolCompaction(toolCompaction: ToolCompactionPolicy) {
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'tool-compaction-update',
          toolCompaction,
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save tool compaction settings')
        return
      }
      setSuccess('Tool compaction settings saved!')
      await load({ force: true })
      setTimeout(() => setSuccess(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  function updateEditing(patch: Partial<ProfileConfig>) {
    if (!editing) return
    setEditing({ ...editing, ...patch })
  }

  async function handleCodexConnect() {
    let profileIdForAuth = editing?.id

    // Persist current codex profile draft before OAuth so id/settings aren't lost.
    if (editing?.provider === 'codex') {
      const action = view === 'add-form' ? 'profile-create' : 'profile-update'
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profile: editing, originalProfileId: action === 'profile-update' ? editingOriginalId : undefined }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save profile before OAuth connect')
        return
      }
      profileIdForAuth = editing.id
      setEditingBaseline(JSON.stringify(editing))
      await load({ force: true })
    }

    const url = profileIdForAuth
      ? `/api/auth/codex/authorize?profileId=${encodeURIComponent(profileIdForAuth)}`
      : '/api/auth/codex/authorize'

    window.location.assign(url)
  }

  async function handleAnthropicConnect() {
    let profileIdForAuth = editing?.id

    // Persist current anthropic-oauth profile draft before OAuth so id/settings aren't lost.
    if (editing?.provider === 'anthropic-oauth') {
      const action = view === 'add-form' ? 'profile-create' : 'profile-update'
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profile: editing, originalProfileId: action === 'profile-update' ? editingOriginalId : undefined }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save profile before OAuth connect')
        return
      }
      profileIdForAuth = editing.id
      setEditingBaseline(JSON.stringify(editing))
      await load({ force: true })
    }

    const url = profileIdForAuth
      ? `/api/auth/anthropic/authorize?profileId=${encodeURIComponent(profileIdForAuth)}`
      : '/api/auth/anthropic/authorize'

    window.location.assign(url)
  }

  const isCodex = editing?.provider === 'codex'
  const hasCodexToken = isCodex && (editing?.codexRefreshToken === '***' || (editing?.codexRefreshToken?.length ?? 0) > 0)
  const codexStatus = editing?.id ? codexAuthState[editing.id] : undefined
  const isAnthropicOAuth = editing?.provider === 'anthropic-oauth'
  const hasAnthropicOAuthToken = isAnthropicOAuth && (
    hasStoredSecret(editing?.anthropicOAuthRefreshToken) || hasStoredSecret(editing?.claudeAuthToken)
  )
  const anthropicStatus = editing?.id ? anthropicAuthState[editing.id] : undefined
  const usesOAuthConnection = isCodex || isAnthropicOAuth
  const contextMode = config.contextManagement.mode
  const showCompactionFields = contextMode !== 'off'
  const showSummaryFields = contextMode === 'summary' || contextMode === 'running-summary'
  const showRunningSummaryFields = contextMode === 'running-summary'
  const toolCompactionMode = config.toolCompaction.mode
  const showToolCompactionThreshold = toolCompactionMode !== 'off'
  const showToolSummaryFields = toolCompactionMode === 'summary'
  const showToolTruncateFields = toolCompactionMode === 'summary' || toolCompactionMode === 'truncate'

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        {view !== 'list' && (
          <button onClick={back} className="text-sm text-blue-600 hover:underline dark:text-blue-400">← Back</button>
        )}
      </div>

      {/* Status messages */}
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-400">{success}</div>}

      {/* === LIST VIEW === */}
      {view === 'list' && (
        <>
          {/* Profiles */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Provider Profiles</h2>
              <button onClick={startAdd} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">+ Add Profile</button>
            </div>
            {config.profiles.length === 0 && (
              <p className="text-sm text-gray-400">No profiles configured. Add one to get started.</p>
            )}
            {config.profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.id}</div>
                  <div className="text-xs text-gray-500">
                    {p.provider} · {p.allowedModels.length} models · {p.enabled ? '✅ enabled' : '⏸ disabled'}
                    {p.provider === 'codex'
                      ? (codexAuthState[p.id] === 'ok'
                        ? ' · 🟢 oauth ok'
                        : codexAuthState[p.id] === 'expired'
                          ? ' · 🔴 re-auth required'
                          : codexAuthState[p.id] === 'disconnected'
                            ? ' · 🟡 disconnected'
                            : codexAuthState[p.id] === 'unknown'
                              ? ' · 🟠 status unknown'
                              : '')
                      : p.provider === 'anthropic-oauth'
                        ? (anthropicAuthState[p.id] === 'ok'
                          ? ' · 🟢 oauth ok'
                          : anthropicAuthState[p.id] === 'expired'
                            ? ' · 🔴 re-auth required'
                            : anthropicAuthState[p.id] === 'disconnected'
                              ? ' · 🟡 disconnected'
                              : anthropicAuthState[p.id] === 'unknown'
                                ? ' · 🟠 status unknown'
                                : '')
                        : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => startEdit(p)} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">Edit</button>
                  <button onClick={() => void deleteProfile(p.id)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400">Delete</button>
                </div>
              </div>
            ))}
          </section>

          {/* Model Priority */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Model Priority</h2>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <ModelPriorityEditor
                modelPriority={config.routing.modelPriority}
                profiles={config.profiles}
                onChange={(mp) => setConfig({ ...config, routing: { ...config.routing, modelPriority: mp } })}
              />
              <div className="mt-3">
                {hasUnsavedRoutingChanges && (
                  <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">⚠ You have unsaved model priority changes</p>
                )}
                <button onClick={() => void saveRouting(config.routing.modelPriority)} disabled={saving}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save Priority'}
                </button>
              </div>
            </div>
          </section>

          {/* Context Management */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Context Management</h2>
            <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Compaction Mode</label>
                <select
                  className={FIELD_CLASS}
                  value={config.contextManagement.mode}
                  onChange={(e) => {
                    const mode = e.target.value as ContextManagementPolicy['mode']
                    setConfig({
                      ...config,
                      contextManagement: { ...config.contextManagement, mode },
                    })
                  }}
                >
                  {CONTEXT_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400">
                  {CONTEXT_MODE_OPTIONS.find((opt) => opt.value === config.contextManagement.mode)?.hint}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {showCompactionFields && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-500">Max Context Tokens</label>
                    <input
                      type="number"
                      min={1024}
                      className={FIELD_CLASS}
                      value={config.contextManagement.maxContextTokens}
                      onChange={(e) => setConfig({
                        ...config,
                        contextManagement: {
                          ...config.contextManagement,
                          maxContextTokens: Math.max(1024, parseInt(e.target.value || '0', 10) || 150000),
                        },
                      })}
                    />
                  </div>
                )}

                {showCompactionFields && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Compaction Threshold (0-1)</label>
                      <input
                        type="number"
                        min={0.05}
                        max={0.99}
                        step={0.01}
                        className={FIELD_CLASS}
                        value={config.contextManagement.compactionThreshold}
                        onChange={(e) => {
                          const next = clamp(parseFloat(e.target.value || '0'), 0.05, 0.99)
                          setConfig({
                            ...config,
                            contextManagement: { ...config.contextManagement, compactionThreshold: next },
                          })
                        }}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Target Ratio After Compaction</label>
                      <input
                        type="number"
                        min={0.02}
                        max={0.95}
                        step={0.01}
                        className={FIELD_CLASS}
                        value={config.contextManagement.targetContextRatio}
                        onChange={(e) => {
                          const next = clamp(parseFloat(e.target.value || '0'), 0.02, 0.95)
                          setConfig({
                            ...config,
                            contextManagement: { ...config.contextManagement, targetContextRatio: next },
                          })
                        }}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Keep Recent Messages</label>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        className={FIELD_CLASS}
                        value={config.contextManagement.keepRecentMessages}
                        onChange={(e) => setConfig({
                          ...config,
                          contextManagement: {
                            ...config.contextManagement,
                            keepRecentMessages: clamp(parseInt(e.target.value || '1', 10) || 1, 1, 200),
                          },
                        })}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Minimum Recent Messages</label>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        className={FIELD_CLASS}
                        value={config.contextManagement.minRecentMessages}
                        onChange={(e) => setConfig({
                          ...config,
                          contextManagement: {
                            ...config.contextManagement,
                            minRecentMessages: clamp(parseInt(e.target.value || '1', 10) || 1, 1, 200),
                          },
                        })}
                      />
                    </div>
                  </>
                )}

                {showSummaryFields && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Summary Max Tokens</label>
                      <input
                        type="number"
                        min={200}
                        max={4000}
                        className={FIELD_CLASS}
                        value={config.contextManagement.summaryMaxTokens}
                        onChange={(e) => setConfig({
                          ...config,
                          contextManagement: {
                            ...config.contextManagement,
                            summaryMaxTokens: clamp(parseInt(e.target.value || '200', 10) || 200, 200, 4000),
                          },
                        })}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Transcript Max Chars</label>
                      <input
                        type="number"
                        min={4000}
                        max={500000}
                        className={FIELD_CLASS}
                        value={config.contextManagement.transcriptMaxChars}
                        onChange={(e) => setConfig({
                          ...config,
                          contextManagement: {
                            ...config.contextManagement,
                            transcriptMaxChars: clamp(parseInt(e.target.value || '4000', 10) || 4000, 4000, 500000),
                          },
                        })}
                      />
                    </div>
                  </>
                )}

                {showRunningSummaryFields && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-500">Running Summary Threshold</label>
                    <input
                      type="number"
                      min={0.02}
                      max={0.99}
                      step={0.01}
                      className={FIELD_CLASS}
                      value={config.contextManagement.runningSummaryThreshold}
                      onChange={(e) => {
                        const next = clamp(parseFloat(e.target.value || '0'), 0.02, 0.99)
                        setConfig({
                          ...config,
                          contextManagement: { ...config.contextManagement, runningSummaryThreshold: next },
                        })
                      }}
                    />
                  </div>
                )}
              </div>

              <div>
                {hasUnsavedContextManagementChanges && (
                  <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">⚠ You have unsaved context management changes</p>
                )}
                <button
                  onClick={() => void saveContextManagement(config.contextManagement)}
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Context Settings'}
                </button>
              </div>
            </div>
          </section>

          {/* Tool Compaction */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Tool Compaction</h2>
            <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Tool Compaction Mode</label>
                <select
                  className={FIELD_CLASS}
                  value={config.toolCompaction.mode}
                  onChange={(e) => {
                    const mode = e.target.value as ToolCompactionPolicy['mode']
                    setConfig({
                      ...config,
                      toolCompaction: {
                        ...config.toolCompaction,
                        mode,
                      },
                    })
                  }}
                >
                  {TOOL_COMPACTION_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400">
                  {TOOL_COMPACTION_MODE_OPTIONS.find((opt) => opt.value === config.toolCompaction.mode)?.hint}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {showToolCompactionThreshold && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-500">Threshold Tokens</label>
                    <input
                      type="number"
                      min={1}
                      max={1000000}
                      className={FIELD_CLASS}
                      value={config.toolCompaction.thresholdTokens}
                      onChange={(e) => setConfig({
                        ...config,
                        toolCompaction: {
                          ...config.toolCompaction,
                          thresholdTokens: clamp(parseInt(e.target.value || '1', 10) || 1, 1, 1_000_000),
                        },
                      })}
                    />
                  </div>
                )}

                {showToolSummaryFields && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Summary Max Tokens</label>
                      <input
                        type="number"
                        min={100}
                        max={4000}
                        className={FIELD_CLASS}
                        value={config.toolCompaction.summaryMaxTokens}
                        onChange={(e) => setConfig({
                          ...config,
                          toolCompaction: {
                            ...config.toolCompaction,
                            summaryMaxTokens: clamp(parseInt(e.target.value || '100', 10) || 100, 100, 4000),
                          },
                        })}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-500">Summary Input Max Chars</label>
                      <input
                        type="number"
                        min={1000}
                        max={500000}
                        className={FIELD_CLASS}
                        value={config.toolCompaction.summaryInputMaxChars}
                        onChange={(e) => setConfig({
                          ...config,
                          toolCompaction: {
                            ...config.toolCompaction,
                            summaryInputMaxChars: clamp(parseInt(e.target.value || '1000', 10) || 1000, 1000, 500000),
                          },
                        })}
                      />
                    </div>
                  </>
                )}

                {showToolTruncateFields && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-500">Truncate Max Chars</label>
                    <input
                      type="number"
                      min={500}
                      max={200000}
                      className={FIELD_CLASS}
                      value={config.toolCompaction.truncateMaxChars}
                      onChange={(e) => setConfig({
                        ...config,
                        toolCompaction: {
                          ...config.toolCompaction,
                          truncateMaxChars: clamp(parseInt(e.target.value || '500', 10) || 500, 500, 200000),
                        },
                      })}
                    />
                  </div>
                )}
              </div>

              <div>
                {hasUnsavedToolCompactionChanges && (
                  <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">⚠ You have unsaved tool compaction changes</p>
                )}
                <button
                  onClick={() => void saveToolCompaction(config.toolCompaction)}
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Tool Compaction'}
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {/* === ADD: CHOOSE PROVIDER === */}
      {view === 'add-choose' && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Choose Provider Type</h2>
          <div className="space-y-2">
            {PROVIDER_OPTIONS.map((opt) => (
              <button key={opt.value} onClick={() => chooseProvider(opt.value)}
                className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{opt.label}</div>
                  <div className="text-xs text-gray-500">{opt.description}</div>
                </div>
                <span className="text-gray-400">→</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* === ADD/EDIT FORM === */}
      {(view === 'add-form' || view === 'edit') && editing && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            {view === 'add-form' ? 'New' : 'Edit'} {PROVIDER_OPTIONS.find((o) => o.value === editing.provider)?.label} Profile
          </h2>

          {/* ID */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">Profile ID</label>
            <div className="flex items-center rounded border border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-800">
              <span className="border-r border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">{editing.provider}:</span>
              <input
                className="w-full rounded-r border-0 bg-white px-2 py-1.5 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                value={editing.id.startsWith(`${editing.provider}:`) ? editing.id.slice(`${editing.provider}:`.length) : editing.id}
                placeholder={editing.provider === 'codex' || editing.provider === 'anthropic-oauth' ? 'oauth' : 'default'}
                onChange={(e) => updateEditing({ id: `${editing.provider}:${e.target.value.replace(/\s+/g, '-')}` })}
              />
            </div>
            <p className="text-xs text-gray-400">Provider prefix is fixed to prevent invalid IDs.</p>
          </div>

          {/* Connection: API Key (anthropic/openai) */}
          {!usesOAuthConnection && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">API Key</label>
              <input type="password" className={FIELD_CLASS} value={editing.apiKey ?? ''}
                placeholder="sk-..."
                onChange={(e) => updateEditing({ apiKey: e.target.value })} />
            </div>
          )}

          {/* Connection: Anthropic OAuth */}
          {isAnthropicOAuth && (
            <div className="space-y-2">
              {hasAnthropicOAuthToken && anthropicStatus === 'ok' && (
                <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
                  ✅ Connected via OAuth
                </div>
              )}
              {hasAnthropicOAuthToken && anthropicStatus === 'expired' && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                  ⚠ OAuth token refresh failed. Re-auth required.
                </div>
              )}
              {hasAnthropicOAuthToken && anthropicStatus === 'unknown' && (
                <div className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                  ⚠ OAuth status is unknown. Please reconnect to verify this profile.
                </div>
              )}
              {!hasAnthropicOAuthToken && (
                <div className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                  Not connected yet. OAuth has not been completed for this profile.
                </div>
              )}
              <div className="space-y-2">
                <p className="text-sm text-gray-600 dark:text-gray-300">Authenticate or re-authenticate with Anthropic.</p>
                <button
                  onClick={handleAnthropicConnect}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                >
                  🔗 Connect with Anthropic →
                </button>
              </div>
            </div>
          )}

          {/* Connection: Codex OAuth */}
          {isCodex && (
            <div className="space-y-2">
              {hasCodexToken && codexStatus === 'ok' && (
                <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
                  ✅ Connected via OAuth
                </div>
              )}
              {hasCodexToken && codexStatus === 'expired' && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                  ⚠ OAuth token refresh failed. Re-auth required.
                </div>
              )}
              {hasCodexToken && codexStatus === 'unknown' && (
                <div className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                  ⚠ OAuth status is unknown. Please reconnect to verify this profile.
                </div>
              )}
              {!hasCodexToken && (
                <div className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
                  Not connected yet. OAuth has not been completed for this profile.
                </div>
              )}
              <div className="space-y-2">
                <p className="text-sm text-gray-600 dark:text-gray-300">Authenticate or re-authenticate with OpenAI.</p>
                <button onClick={handleCodexConnect}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
                  🔗 Connect with OpenAI →
                </button>
              </div>
            </div>
          )}

          {/* System Prompts */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">System Prompts <span className="text-gray-400">(one per line, in order)</span></label>
            <textarea className={FIELD_CLASS} rows={4}
              value={editing.systemPrompts.join('\n')}
              placeholder="Enter system prompts, one per line…"
              onChange={(e) => updateEditing({ systemPrompts: e.target.value.split('\n').filter((x) => x.length > 0) })} />
          </div>

          {/* Allowed Models */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-gray-500">Allowed Models</label>
            <div className="flex flex-wrap gap-2">
              {editing.allowedModels.map((m) => (
                <span key={m} className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-200 px-2 py-1 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
                  {m}
                  <button
                    type="button"
                    className="text-gray-500 hover:text-red-500"
                    onClick={() => updateEditing({ allowedModels: editing.allowedModels.filter((x) => x !== m) })}
                    title="Remove model"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_MODELS[editing.provider].map((m) => {
                const selected = editing.allowedModels.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateEditing({
                      allowedModels: selected
                        ? editing.allowedModels.filter((x) => x !== m)
                        : [...editing.allowedModels, m],
                    })}
                    className={`rounded-full border px-2 py-1 text-xs ${selected ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-300'}`}
                  >
                    {selected ? '✓ ' : '+ '}{m}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2">
              <input
                className={"flex-1 " + FIELD_CLASS}
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                placeholder="Add custom model id (e.g. gpt-5.3-codex)"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const model = customModelInput.trim()
                  if (!model || editing.allowedModels.includes(model)) return
                  updateEditing({ allowedModels: [...editing.allowedModels, model] })
                  setCustomModelInput('')
                }}
              />
              <button
                type="button"
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                onClick={() => {
                  const model = customModelInput.trim()
                  if (!model || editing.allowedModels.includes(model)) return
                  updateEditing({ allowedModels: [...editing.allowedModels, model] })
                  setCustomModelInput('')
                }}
              >
                Add
              </button>
            </div>
          </div>

          {/* Advanced toggle */}
          <button onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400">
            {showAdvanced ? '▼ Hide' : '▶ Show'} Advanced Settings
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Base URL Override</label>
                <input className={FIELD_CLASS} value={editing.baseUrl ?? ''} placeholder="Leave empty for default"
                  onChange={(e) => updateEditing({ baseUrl: e.target.value || undefined })} />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-500">Custom Headers <span className="text-gray-400">(key/value builder)</span></label>
                <div className="space-y-2">
                  {Object.entries(editing.extraHeaders ?? {}).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2">
                      <input
                        className={"w-1/3 " + SMALL_FIELD_CLASS}
                        value={k}
                        onChange={(e) => {
                          const nextKey = e.target.value
                          const current = { ...(editing.extraHeaders ?? {}) }
                          const value = current[k]
                          delete current[k]
                          if (nextKey.trim()) current[nextKey] = value
                          updateEditing({ extraHeaders: Object.keys(current).length ? current : undefined })
                        }}
                      />
                      <input
                        className={"flex-1 " + SMALL_FIELD_CLASS}
                        value={String(v)}
                        onChange={(e) => {
                          const current = { ...(editing.extraHeaders ?? {}) }
                          current[k] = e.target.value
                          updateEditing({ extraHeaders: current })
                        }}
                      />
                      <button
                        type="button"
                        className="rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:bg-gray-800"
                        onClick={() => {
                          const current = { ...(editing.extraHeaders ?? {}) }
                          delete current[k]
                          updateEditing({ extraHeaders: Object.keys(current).length ? current : undefined })
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className={"w-1/3 " + SMALL_FIELD_CLASS}
                    placeholder="Header name"
                    value={headerDraftKey}
                    onChange={(e) => setHeaderDraftKey(e.target.value)}
                  />
                  <input
                    className={"flex-1 " + SMALL_FIELD_CLASS}
                    placeholder="Header value"
                    value={headerDraftValue}
                    onChange={(e) => setHeaderDraftValue(e.target.value)}
                  />
                  <button
                    type="button"
                    className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                    onClick={() => {
                      const k = headerDraftKey.trim()
                      if (!k) return
                      const current = { ...(editing.extraHeaders ?? {}) }
                      current[k] = headerDraftValue
                      updateEditing({ extraHeaders: current })
                      setHeaderDraftKey('')
                      setHeaderDraftValue('')
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Required First System Prompt <span className="text-gray-400">(locked, always first)</span></label>
                <textarea className={FIELD_CLASS} rows={2} value={editing.requiredFirstSystemPrompt ?? ''} placeholder="Optional — immutable once set"
                  onChange={(e) => updateEditing({ requiredFirstSystemPrompt: e.target.value || undefined })} />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => updateEditing({ enabled: e.target.checked })} />
                Profile enabled
              </label>
            </div>
          )}

          {hasUnsavedProfileChanges && (
            <p className="text-xs text-amber-600 dark:text-amber-400">⚠ You have unsaved changes</p>
          )}
          <button onClick={() => void saveProfile()} disabled={saving}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : success ? '✅ Saved!' : 'Save Profile'}
          </button>
        </section>
      )}
    </div>
  )
}
