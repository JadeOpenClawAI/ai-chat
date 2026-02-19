'use client'

import { useEffect, useState } from 'react'
import type { AppConfig, ProfileConfig, RoutingPolicy } from '@/lib/config/store'

const NEW_PROFILE: ProfileConfig = {
  id: 'anthropic:new-profile',
  provider: 'anthropic',
  displayName: 'New Profile',
  enabled: true,
  allowedModels: ['claude-sonnet-4-5'],
  systemPrompts: [],
}

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [editing, setEditing] = useState<ProfileConfig>(NEW_PROFILE)

  async function load() {
    const res = await fetch('/api/settings')
    const data = (await res.json()) as { config: AppConfig }
    setConfig(data.config)
    if (data.config.profiles[0]) setEditing(data.config.profiles[0])
  }

  useEffect(() => {
    void load()
  }, [])

  if (!config) return <div className="p-4 text-sm">Loading…</div>

  async function saveProfile() {
    if (!config) return
    const exists = config.profiles.some((p) => p.id === editing.id)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: exists ? 'profile-update' : 'profile-create', profile: editing }),
    })
    await load()
  }

  async function deleteProfile(id: string) {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteProfileId: id }),
    })
    await load()
  }

  async function saveRouting(routing: RoutingPolicy) {
    if (!config) return
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routing }),
    })
    await load()
  }

  return (
    <div className="space-y-4 p-2">
      <div className="rounded border p-3">
        <div className="mb-2 text-sm font-semibold">Profiles</div>
        <div className="space-y-1 text-sm">
          {config.profiles.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded border px-2 py-1">
              <button onClick={() => setEditing(p)}>{p.id}</button>
              <button onClick={() => void deleteProfile(p.id)} className="text-red-600">Delete</button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 rounded border p-3 text-sm">
        <div className="font-semibold">Edit profile</div>
        <input className="w-full rounded border px-2 py-1" value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
        <input className="w-full rounded border px-2 py-1" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
        <select className="w-full rounded border px-2 py-1" value={editing.provider} onChange={(e) => setEditing({ ...editing, provider: e.target.value as ProfileConfig['provider'] })}>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="codex">codex</option>
        </select>
        <input className="w-full rounded border px-2 py-1" value={editing.apiKey ?? ''} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="api key or ***" />
        <input className="w-full rounded border px-2 py-1" value={editing.requiredFirstSystemPrompt ?? ''} onChange={(e) => setEditing({ ...editing, requiredFirstSystemPrompt: e.target.value || undefined })} placeholder="required first prompt" />
        <textarea className="w-full rounded border px-2 py-1" rows={4} value={editing.systemPrompts.join('\n')} onChange={(e) => setEditing({ ...editing, systemPrompts: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        <button className="rounded border px-3 py-1" onClick={() => void saveProfile()}>Save profile</button>
      </div>

      <div className="space-y-2 rounded border p-3 text-sm">
        <div className="font-semibold">Routing</div>
        <input className="w-full rounded border px-2 py-1" value={config.routing.primary.profileId} onChange={(e) => setConfig({ ...config, routing: { ...config.routing, primary: { ...config.routing.primary, profileId: e.target.value } } })} />
        <input className="w-full rounded border px-2 py-1" value={config.routing.primary.modelId} onChange={(e) => setConfig({ ...config, routing: { ...config.routing, primary: { ...config.routing.primary, modelId: e.target.value } } })} />
        <textarea className="w-full rounded border px-2 py-1" rows={4} value={config.routing.fallbacks.map((f) => `${f.profileId} ${f.modelId}`).join('\n')} onChange={(e) => setConfig({ ...config, routing: { ...config.routing, fallbacks: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [profileId, modelId] = line.split(/\s+/); return { profileId, modelId: modelId ?? '' } }) } })} />
        <button className="rounded border px-3 py-1" onClick={() => void saveRouting(config.routing)}>Save routing</button>
      </div>
    </div>
  )
}
