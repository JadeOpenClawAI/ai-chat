'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle2, Trash2, RefreshCw, Link } from 'lucide-react'
import { ExtraHeadersEditor } from './ExtraHeadersEditor'
import { ConnectionTestButton } from './ConnectionTestButton'

export type ProviderKey = 'anthropic' | 'openai' | 'codex'

export interface ProviderState {
  apiKey: string // '' means not set, '***' means set (masked)
  baseUrl: string
  extraHeaders: Record<string, string>
  systemPrompt: string
  codexClientId: string
  codexClientSecret: string
  codexRefreshToken: string
}

interface Props {
  provider: ProviderKey
  title: string
  emoji: string
  defaultModel?: string
  state: ProviderState
  onSave: (provider: ProviderKey, state: ProviderState) => Promise<void>
  onRefreshCodexState?: () => Promise<void>
}

interface SecretFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  isEditing: boolean
  onEditToggle: () => void
}

function SecretField({ label, value, onChange, isEditing, onEditToggle }: SecretFieldProps) {
  const [show, setShow] = useState(false)
  const isMasked = value === '***'

  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</label>
      {isMasked && !isEditing ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-400 dark:border-gray-700 dark:bg-gray-900">
            ●●●●●●●●●●●●●●●●
          </div>
          <button
            type="button"
            onClick={onEditToggle}
            className="rounded px-2 py-1.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
          >
            Edit
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={show ? 'text' : 'password'}
              value={isEditing ? value : ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={`Enter ${label.toLowerCase()}`}
              className="w-full rounded border border-blue-300 bg-white px-3 py-1.5 pr-8 text-xs text-gray-700 outline-none focus:ring-1 focus:ring-blue-400 dark:border-blue-700 dark:bg-gray-900 dark:text-gray-300"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"
            >
              {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
          </div>
          {isMasked && (
            <button
              type="button"
              onClick={onEditToggle}
              className="rounded px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface CodexCardProps {
  state: ProviderState
  defaultModel?: string
  onDisconnect: () => void
  onRefreshState?: () => Promise<void>
}

function CodexOAuthCard({ state, defaultModel, onDisconnect, onRefreshState }: CodexCardProps) {
  const isConnected = state.codexRefreshToken === '***' || state.codexRefreshToken.length > 0
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)

  async function handleRefreshToken() {
    setRefreshing(true)
    setRefreshResult(null)
    try {
      const res = await fetch('/api/settings/codex-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      setRefreshResult(data.ok ? `✅ Token refreshed` : `❌ ${data.error ?? 'Refresh failed'}`)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleRevoke() {
    setRevoking(true)
    try {
      await fetch('/api/settings/codex-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke' }),
      })
      onDisconnect()
      await onRefreshState?.()
    } finally {
      setRevoking(false)
    }
  }

  function handleConnect() {
    window.location.href = '/api/auth/codex/authorize'
  }

  return (
    <div className="space-y-4 p-4">
      {isConnected ? (
        <>
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 dark:bg-green-950">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
            <span className="text-xs font-medium text-green-700 dark:text-green-300">Authorized via OpenAI OAuth</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
            <ConnectionTestButton provider="codex" model={defaultModel} />
            <button
              type="button"
              onClick={handleRefreshToken}
              disabled={refreshing}
              className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh Token
            </button>
            <button
              type="button"
              onClick={handleRevoke}
              disabled={revoking}
              className="flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Disconnect
            </button>
          </div>
          {refreshResult && <p className="text-xs text-gray-500 dark:text-gray-400">{refreshResult}</p>}
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            One-click OAuth login. No manual refresh token paste needed.
          </p>
          <button
            type="button"
            onClick={handleConnect}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
          >
            <Link className="h-4 w-4" />
            Connect with OpenAI →
          </button>
          <p className="text-center text-xs text-gray-400 dark:text-gray-500">
            Opens OpenAI login and returns you here automatically.
          </p>
        </>
      )}
    </div>
  )
}

export function ProviderCard({ provider, title, emoji, defaultModel, state, onSave, onRefreshCodexState }: Props) {
  const [local, setLocal] = useState<ProviderState>(state)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState({ apiKey: false })

  const isConnected =
    provider === 'codex'
      ? local.codexRefreshToken === '***' || local.codexRefreshToken.length > 0
      : local.apiKey === '***' || local.apiKey.length > 0

  function toggleEdit(field: keyof typeof editing) {
    setEditing((prev) => ({ ...prev, [field]: !prev[field] }))
    if (editing[field]) {
      setLocal((prev) => ({ ...prev, [field]: state[field as keyof ProviderState] as string }))
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    try {
      await onSave(provider, local)
      setSaved(true)
      setEditing({ apiKey: false })
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  function handleCodexDisconnect() {
    setLocal((prev) => ({ ...prev, codexRefreshToken: '' }))
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-lg">{emoji}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{title}</span>
        </div>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            isConnected
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
          }`}
        >
          {isConnected ? (
            <>
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </>
          ) : (
            'Not configured'
          )}
        </span>
      </div>

      {provider === 'codex' ? (
        <CodexOAuthCard
          state={local}
          defaultModel={defaultModel}
          onDisconnect={handleCodexDisconnect}
          onRefreshState={onRefreshCodexState}
        />
      ) : (
        <div className="space-y-4 p-4">
          <SecretField
            label="API Key"
            value={local.apiKey}
            onChange={(v) => setLocal((prev) => ({ ...prev, apiKey: v }))}
            isEditing={editing.apiKey}
            onEditToggle={() => toggleEdit('apiKey')}
          />

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Base URL <span className="text-gray-400">(optional override)</span>
            </label>
            <input
              type="url"
              value={local.baseUrl}
              onChange={(e) => setLocal((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
              className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Extra Headers</label>
            <ExtraHeadersEditor
              headers={local.extraHeaders}
              onChange={(h) => setLocal((prev) => ({ ...prev, extraHeaders: h }))}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">System Prompt Override</label>
            <textarea
              value={local.systemPrompt}
              onChange={(e) => setLocal((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="Leave empty to use default system prompt…"
              rows={3}
              className="w-full resize-y rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            />
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-800">
            <ConnectionTestButton provider={provider} model={defaultModel} />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
              {saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
