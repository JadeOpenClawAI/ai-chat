'use client'

import { useEffect, useState } from 'react'
import type { AppConfig, ProfileConfig, RoutingPolicy } from '@/lib/config/store'
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
  codex: ['codex-mini-latest', 'o3', 'o4-mini'],
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

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [view, setView] = useState<View>('list')
  const [editing, setEditing] = useState<ProfileConfig | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load() {
    const res = await fetch('/api/settings')
    const data = (await res.json()) as { config: AppConfig }
    setConfig(data.config)
  }

  useEffect(() => { void load() }, [])

  if (!config) return <div className="p-6 text-sm text-gray-500">Loading…</div>

  function startAdd() {
    setView('add-choose')
    setEditing(null)
    setShowAdvanced(false)
    setError('')
    setSuccess('')
  }

  function chooseProvider(provider: LLMProvider) {
    setEditing(makeNewProfile(provider))
    setView('add-form')
    setShowAdvanced(false)
  }

  function startEdit(profile: ProfileConfig) {
    setEditing({ ...profile })
    setView('edit')
    setShowAdvanced(false)
    setError('')
    setSuccess('')
  }

  function back() {
    setView('list')
    setEditing(null)
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

  async function saveRouting() {
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'routing-update', routing: config.routing }),
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

  // Codex OAuth connect
  function handleCodexConnect() {
    window.location.href = '/api/auth/codex/authorize'
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

          {/* Routing */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Model Routing &amp; Fallbacks</h2>
            <p className="text-xs text-gray-500">Primary route is tried first. Fallbacks are attempted in order if primary fails.</p>
            <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <label className="text-xs font-medium text-gray-500">Primary Profile</label>
              <select className="w-full rounded border px-2 py-1 text-sm" value={config.routing.primary.profileId}
                onChange={(e) => setConfig({ ...config, routing: { ...config.routing, primary: { ...config.routing.primary, profileId: e.target.value } } })}>
                {config.profiles.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
              <label className="text-xs font-medium text-gray-500">Primary Model</label>
              <input className="w-full rounded border px-2 py-1 text-sm" value={config.routing.primary.modelId}
                onChange={(e) => setConfig({ ...config, routing: { ...config.routing, primary: { ...config.routing.primary, modelId: e.target.value } } })} />
              <label className="text-xs font-medium text-gray-500">Fallbacks <span className="text-gray-400">(one per line: profileId modelId)</span></label>
              <textarea className="w-full rounded border px-2 py-1 text-sm" rows={3}
                value={config.routing.fallbacks.map((f) => `${f.profileId} ${f.modelId}`).join('\n')}
                onChange={(e) => setConfig({
                  ...config,
                  routing: {
                    ...config.routing,
                    fallbacks: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
                      const [profileId, modelId] = l.split(/\s+/)
                      return { profileId, modelId: modelId ?? '' }
                    }),
                  },
                })} />
              <button onClick={() => void saveRouting()} disabled={saving}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Routing'}
              </button>
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
                  <p className="text-center text-xs text-gray-400">Opens OpenAI login. Redirects back automatically.</p>
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
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">Allowed Models</label>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_MODELS[editing.provider].map((m) => (
                <label key={m} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={editing.allowedModels.includes(m)}
                    onChange={(e) => updateEditing({
                      allowedModels: e.target.checked
                        ? [...editing.allowedModels, m]
                        : editing.allowedModels.filter((x) => x !== m),
                    })} />
                  {m}
                </label>
              ))}
            </div>
          </div>

          {/* Advanced toggle */}
          <button onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400">
            {showAdvanced ? '▼ Hide' : '▶ Show'} Advanced Settings
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              {/* Base URL */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Base URL Override</label>
                <input className="w-full rounded border px-2 py-1.5 text-sm" value={editing.baseUrl ?? ''} placeholder="Leave empty for default"
                  onChange={(e) => updateEditing({ baseUrl: e.target.value || undefined })} />
              </div>

              {/* Custom Headers */}
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

              {/* Required first prompt */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500">Required First System Prompt <span className="text-gray-400">(locked, always first)</span></label>
                <textarea className="w-full rounded border px-2 py-1.5 text-sm" rows={2} value={editing.requiredFirstSystemPrompt ?? ''} placeholder="Optional — immutable once set"
                  onChange={(e) => updateEditing({ requiredFirstSystemPrompt: e.target.value || undefined })} />
              </div>

              {/* Enabled toggle */}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => updateEditing({ enabled: e.target.checked })} />
                Profile enabled
              </label>
            </div>
          )}

          {/* Save */}
          <button onClick={() => void saveProfile()} disabled={saving}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : success ? '✅ Saved!' : 'Save Profile'}
          </button>
        </section>
      )}
    </div>
  )
}
