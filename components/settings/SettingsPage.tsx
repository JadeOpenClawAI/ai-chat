'use client'

import { useEffect, useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { ProviderCard, type ProviderKey, type ProviderState } from './ProviderCard'
import type { AppConfig } from '@/lib/config/store'
import { MODEL_OPTIONS } from '@/lib/types'

type Tab = 'providers' | 'models' | 'system-prompt'

const EMPTY_PROVIDER: ProviderState = {
  apiKey: '',
  baseUrl: '',
  extraHeaders: {},
  systemPrompt: '',
  codexClientId: '',
  codexClientSecret: '',
  codexRefreshToken: '',
}

function configToProviderState(cfg: AppConfig['providers'][ProviderKey]): ProviderState {
  if (!cfg) return EMPTY_PROVIDER
  return {
    apiKey: cfg.apiKey ?? '',
    baseUrl: cfg.baseUrl ?? '',
    extraHeaders: cfg.extraHeaders ?? {},
    systemPrompt: cfg.systemPrompt ?? '',
    codexClientId: cfg.codexClientId ?? '',
    codexClientSecret: cfg.codexClientSecret ?? '',
    codexRefreshToken: cfg.codexRefreshToken ?? '',
  }
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers')
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<AppConfig | null>(null)

  // Derived provider states from loaded config
  const [anthropicState, setAnthropicState] = useState<ProviderState>(EMPTY_PROVIDER)
  const [openaiState, setOpenaiState] = useState<ProviderState>(EMPTY_PROVIDER)
  const [codexState, setCodexState] = useState<ProviderState>(EMPTY_PROVIDER)

  const [defaultProvider, setDefaultProvider] = useState('anthropic')
  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-5')
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState('')
  const [savingGlobal, setSavingGlobal] = useState(false)
  const [savedGlobal, setSavedGlobal] = useState(false)

  const loadConfig = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/settings')
      const data = (await res.json()) as AppConfig
      setConfig(data)
      setAnthropicState(configToProviderState(data.providers?.anthropic))
      setOpenaiState(configToProviderState(data.providers?.openai))
      setCodexState(configToProviderState(data.providers?.codex))
      if (data.defaultProvider) setDefaultProvider(data.defaultProvider)
      if (data.defaultModel) setDefaultModel(data.defaultModel)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  async function handleProviderSave(provider: ProviderKey, state: ProviderState) {
    const body: Partial<AppConfig> & {
      providers: Record<string, Record<string, string | Record<string, string> | undefined>>
    } = {
      providers: {
        [provider]: {
          apiKey: state.apiKey,
          baseUrl: state.baseUrl || undefined,
          extraHeaders: Object.keys(state.extraHeaders).length > 0 ? state.extraHeaders : undefined,
          systemPrompt: state.systemPrompt || undefined,
          codexClientId: state.codexClientId || undefined,
          codexClientSecret: state.codexClientSecret || undefined,
          codexRefreshToken: state.codexRefreshToken || undefined,
        },
      },
    }

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as { ok: boolean; config: AppConfig }
    if (data.ok) {
      setConfig(data.config)
      // Update local state with the sanitized response
      const updatedCfg = data.config.providers[provider]
      if (provider === 'anthropic') setAnthropicState(configToProviderState(updatedCfg))
      if (provider === 'openai') setOpenaiState(configToProviderState(updatedCfg))
      if (provider === 'codex') setCodexState(configToProviderState(updatedCfg))
    }
  }

  async function handleGlobalSave() {
    setSavingGlobal(true)
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultProvider,
          defaultModel,
          providers: globalSystemPrompt
            ? {
                anthropic: { systemPrompt: globalSystemPrompt },
                openai: { systemPrompt: globalSystemPrompt },
                codex: { systemPrompt: globalSystemPrompt },
              }
            : {},
        }),
      })
      setSavedGlobal(true)
      setTimeout(() => setSavedGlobal(false), 3000)
    } finally {
      setSavingGlobal(false)
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'providers', label: 'Providers' },
    { id: 'models', label: 'Models' },
    { id: 'system-prompt', label: 'System Prompt' },
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    )
  }

  // This cast is to acknowledge config is loaded at this point
  void config

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Providers tab */}
      {tab === 'providers' && (
        <div className="space-y-4">
          <ProviderCard
            provider="anthropic"
            title="Anthropic Claude"
            emoji="🤖"
            defaultModel="claude-haiku-3-5"
            state={anthropicState}
            onSave={handleProviderSave}
          />
          <ProviderCard
            provider="openai"
            title="OpenAI"
            emoji="🧠"
            defaultModel="gpt-4o-mini"
            state={openaiState}
            onSave={handleProviderSave}
          />
          <ProviderCard
            provider="codex"
            title="OpenAI Codex (OAuth)"
            emoji="⚡"
            defaultModel="codex-mini-latest"
            state={codexState}
            onSave={handleProviderSave}
          />
        </div>
      )}

      {/* Models tab */}
      {tab === 'models' && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-gray-100">
            Default Provider &amp; Model
          </h2>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Default Provider
              </label>
              <select
                value={defaultProvider}
                onChange={(e) => setDefaultProvider(e.target.value)}
                className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Default Model
              </label>
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              >
                {MODEL_OPTIONS.filter((m) => m.provider === defaultProvider).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleGlobalSave}
              disabled={savingGlobal}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingGlobal && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {savedGlobal ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* System Prompt tab */}
      {tab === 'system-prompt' && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
            Global System Prompt
          </h2>
          <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
            Applies to all providers unless overridden per-provider in the Providers tab.
            Leave empty to use the built-in default.
          </p>
          <textarea
            value={globalSystemPrompt}
            onChange={(e) => setGlobalSystemPrompt(e.target.value)}
            placeholder="You are a helpful assistant…"
            rows={8}
            className="w-full resize-y rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          />
          <div className="mt-3">
            <button
              type="button"
              onClick={handleGlobalSave}
              disabled={savingGlobal}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingGlobal && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {savedGlobal ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
