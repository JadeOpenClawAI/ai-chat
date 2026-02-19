'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, ProfileConfig, RouteTarget } from '@/lib/config/store'
import type { LLMProvider } from '@/lib/types'

type View = 'list' | 'add-choose' | 'add-form' | 'edit'

const PROVIDER_OPTIONS: { value: LLMProvider; label: string; description: string }[] = [
  { value: 'anthropic', label: 'Claude API', description: 'Anthropic Claude models via API key' },
  { value: 'openai', label: 'OpenAI API', description: 'OpenAI models via API key' },
  { value: 'codex', label: 'OpenAI Codex OAuth', description: 'Codex models via OAuth (one-click connect)' },
]

const DEFAULT_MODELS: Record<LLMProvider, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-3-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  codex: ['codex-mini-latest', 'gpt-5.3-codex', 'o3', 'o4-mini'],
}

function makeNewProfile(provider: LLMProvider): ProfileConfig {
  return {
    id: `${provider}:`,
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
          className="w-full rounded border px-2 py-1.5 text-sm"
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
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800 ${added ? 'opacity-40' : ''}`}
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [customModelInput, setCustomModelInput] = useState('')

  async function load() {
    const res = await fetch('/api/settings')
    const data = (await res.json()) as { config: AppConfig }
    setConfig(data.config)
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const oauthError = params.get('oauth_error')
    if (connected === 'codex') {
      setSuccess('✅ Codex OAuth connected successfully')
      setError('')
      window.history.replaceState({}, '', '/settings')
    } else if (oauthError) {
      setError(`Codex OAuth error: ${oauthError}`)
      setSuccess('')
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  if (!config) return <div className="p-6 text-sm text-gray-500">Loading…</div>

  function startAdd() {
    setView('add-choose')
    setEditing(null)
    setShowAdvanced(false)
    setCustomModelInput('')
    setError('')
    setSuccess('')
  }

  function chooseProvider(provider: LLMProvider) {
    setEditing(makeNewProfile(provider))
    setView('add-form')
    setShowAdvanced(false)
    setCustomModelInput('')
  }

  function startEdit(profile: ProfileConfig) {
    setEditing({ ...profile })
    setView('edit')
    setShowAdvanced(false)
    setCustomModelInput('')
    setError('')
    setSuccess('')
  }

  function back() {
    setView('list')
    setEditing(null)
    setCustomModelInput('')
    setError('')
    setSuccess('')
  }

  async function saveProfile() {
    if (!config || !editing) return
    if (!editing.id || !editing.id.match(/^(anthropic|openai|codex):[a-zA-Z0-9._-]+$/)) {
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
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to save')
        return
      }
      setSuccess('Profile saved!')
      await load()
      setTimeout(() => { setSuccess(''); back() }, 1000)
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
    await load()
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
      else { setSuccess('Routing saved!'); await load(); setTimeout(() => setSuccess(''), 2000) }
    } finally {
      setSaving(false)
    }
  }

  function updateEditing(patch: Partial<ProfileConfig>) {
    if (!editing) return
    setEditing({ ...editing, ...patch })
  }

  function handleCodexConnect() {
    const w = window.open('/api/auth/codex/authorize', '_blank', 'noopener,noreferrer')
    if (!w) {
      // Popup blocked fallback
      window.location.href = '/api/auth/codex/authorize'
    }
  }

  const isCodex = editing?.provider === 'codex'
  const isConnected = isCodex && (editing?.codexRefreshToken === '***' || (editing?.codexRefreshToken?.length ?? 0) > 0)

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
                  <div className="text-xs text-gray-500">{p.provider} · {p.allowedModels.length} models · {p.enabled ? '✅ enabled' : '⏸ disabled'}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => startEdit(p)} className="rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Edit</button>
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
                <button onClick={() => void saveRouting(config.routing.modelPriority)} disabled={saving}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save Priority'}
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
            <input className="w-full rounded border px-2 py-1.5 text-sm" value={editing.id} placeholder={`${editing.provider}:my-profile`}
              onChange={(e) => updateEditing({ id: e.target.value })} />
            <p className="text-xs text-gray-400">Must start with {editing.provider}: followed by a name</p>
          </div>

          {/* Connection: API Key (anthropic/openai) */}
          {!isCodex && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">API Key</label>
              <input type="password" className="w-full rounded border px-2 py-1.5 text-sm" value={editing.apiKey ?? ''}
                placeholder="sk-..." onChange={(e) => updateEditing({ apiKey: e.target.value })} />
            </div>
          )}

          {/* Connection: Codex OAuth */}
          {isCodex && (
            <div className="space-y-2">
              {isConnected ? (
                <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
                  ✅ Connected via OAuth
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-gray-600 dark:text-gray-300">Click below to authenticate with OpenAI.</p>
                  <button onClick={handleCodexConnect}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
                    🔗 Connect with OpenAI →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* System Prompts */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">System Prompts <span className="text-gray-400">(one per line, in order)</span></label>
            <textarea className="w-full rounded border px-2 py-1.5 text-sm" rows={4}
              value={editing.systemPrompts.join('\n')}
              placeholder="Enter system prompts, one per line…"
              onChange={(e) => updateEditing({ systemPrompts: e.target.value.split('\n').filter((x) => x.length > 0) })} />
          </div>

          {/* Allowed Models */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-gray-500">Allowed Models</label>
            <div className="flex flex-wrap gap-2">
              {editing.allowedModels.map((m) => (
                <span key={m} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
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
                className="flex-1 rounded border px-2 py-1.5 text-sm"
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
                className="rounded border px-3 py-1.5 text-xs"
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
                <input className="w-full rounded border px-2 py-1.5 text-sm" value={editing.baseUrl ?? ''} placeholder="Leave empty for default"
                  onChange={(e) => updateEditing({ baseUrl: e.target.value || undefined })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Custom Headers <span className="text-gray-400">(JSON object)</span></label>
                <textarea className="w-full rounded border px-2 py-1.5 font-mono text-xs" rows={3}
                  value={editing.extraHeaders ? JSON.stringify(editing.extraHeaders, null, 2) : ''}
                  placeholder='{"X-Custom": "value"}'
                  onChange={(e) => {
                    try {
                      const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined
                      updateEditing({ extraHeaders: parsed })
                    } catch { /* ignore parse errors while typing */ }
                  }} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Required First System Prompt <span className="text-gray-400">(locked, always first)</span></label>
                <textarea className="w-full rounded border px-2 py-1.5 text-sm" rows={2} value={editing.requiredFirstSystemPrompt ?? ''} placeholder="Optional — immutable once set"
                  onChange={(e) => updateEditing({ requiredFirstSystemPrompt: e.target.value || undefined })} />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => updateEditing({ enabled: e.target.checked })} />
                Profile enabled
              </label>
            </div>
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
