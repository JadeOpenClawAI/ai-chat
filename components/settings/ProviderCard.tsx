'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle2, Trash2 } from 'lucide-react'
import { ExtraHeadersEditor } from './ExtraHeadersEditor'
import { ConnectionTestButton } from './ConnectionTestButton'

export type ProviderKey = 'anthropic' | 'openai' | 'codex'

export interface ProviderState {
  apiKey: string          // '' means not set, '***' means set (masked)
  baseUrl: string
  extraHeaders: Record<string, string>
  systemPrompt: string
  // Codex-specific
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
}

// ── Secret field component ───────────────────────────────────

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
              placeholder={`Enter new ${label.toLowerCase()}`}
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

// ── Main ProviderCard ────────────────────────────────────────

export function ProviderCard({ provider, title, emoji, defaultModel, state, onSave }: Props) {
  const [local, setLocal] = useState<ProviderState>(state)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revoking, setRevoking] = useState(false)

  // Track which secret fields are in edit mode
  const [editing, setEditing] = useState({
    apiKey: false,
    codexClientId: false,
    codexClientSecret: false,
    codexRefreshToken: false,
  })

  const isConnected =
    provider === 'codex'
      ? local.codexRefreshToken === '***' || local.codexRefreshToken.length > 0
      : local.apiKey === '***' || local.apiKey.length > 0

  function toggleEdit(field: keyof typeof editing) {
    setEditing((prev) => ({ ...prev, [field]: !prev[field] }))
    // Reset the field value when cancelling edit
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
      // Reset edit states after save
      setEditing({ apiKey: false, codexClientId: false, codexClientSecret: false, codexRefreshToken: false })
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
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
      setLocal((prev) => ({
        ...prev,
        codexClientId: '',
        codexClientSecret: '',
        codexRefreshToken: '',
      }))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      {/* Header */}
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

      {/* Body */}
      <div className="space-y-4 p-4">
        {provider === 'codex' ? (
          // ── Codex OAuth fields ──────────────────────────────
          <>
            <p className="text-xs font-medium text-gray-500 uppercase dark:text-gray-400">
              OAuth Credentials
            </p>
            <SecretField
              label="Client ID"
              value={local.codexClientId}
              onChange={(v) => setLocal((prev) => ({ ...prev, codexClientId: v }))}
              isEditing={editing.codexClientId}
              onEditToggle={() => toggleEdit('codexClientId')}
            />
            <SecretField
              label="Client Secret"
              value={local.codexClientSecret}
              onChange={(v) => setLocal((prev) => ({ ...prev, codexClientSecret: v }))}
              isEditing={editing.codexClientSecret}
              onEditToggle={() => toggleEdit('codexClientSecret')}
            />
            <SecretField
              label="Refresh Token"
              value={local.codexRefreshToken}
              onChange={(v) => setLocal((prev) => ({ ...prev, codexRefreshToken: v }))}
              isEditing={editing.codexRefreshToken}
              onEditToggle={() => toggleEdit('codexRefreshToken')}
            />
          </>
        ) : (
          // ── Standard API key field ─────────────────────────
          <SecretField
            label="API Key"
            value={local.apiKey}
            onChange={(v) => setLocal((prev) => ({ ...prev, apiKey: v }))}
            isEditing={editing.apiKey}
            onEditToggle={() => toggleEdit('apiKey')}
          />
        )}

        {/* Base URL */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Base URL <span className="text-gray-400">(optional override)</span>
          </label>
          <input
            type="url"
            value={local.baseUrl}
            onChange={(e) => setLocal((prev) => ({ ...prev, baseUrl: e.target.value }))}
            placeholder={
              provider === 'anthropic'
                ? 'https://api.anthropic.com'
                : provider === 'openai'
                  ? 'https://api.openai.com/v1'
                  : 'https://api.openai.com/v1'
            }
            className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          />
        </div>

        {/* Extra Headers */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Extra Headers
          </label>
          <ExtraHeadersEditor
            headers={local.extraHeaders}
            onChange={(h) => setLocal((prev) => ({ ...prev, extraHeaders: h }))}
          />
        </div>

        {/* System Prompt */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
            System Prompt Override
          </label>
          <textarea
            value={local.systemPrompt}
            onChange={(e) => setLocal((prev) => ({ ...prev, systemPrompt: e.target.value }))}
            placeholder="Leave empty to use default system prompt…"
            rows={3}
            className="w-full resize-y rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-800">
          <ConnectionTestButton provider={provider} model={defaultModel} />
          <div className="flex items-center gap-2">
            {provider === 'codex' && isConnected && (
              <button
                type="button"
                onClick={handleRevoke}
                disabled={revoking}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                {revoking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                Revoke
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : saved ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : null}
              {saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
