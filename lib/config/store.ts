// ============================================================
// Server-only config store — never import in client components
// Persists provider credentials to config/providers.json
// ============================================================

import fs from 'fs/promises'
import path from 'path'

const CONFIG_PATH = path.join(process.cwd(), 'config', 'providers.json')

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  extraHeaders?: Record<string, string>
  systemPrompt?: string
  // Codex OAuth specific
  codexClientId?: string
  codexClientSecret?: string
  codexRefreshToken?: string
}

export interface AppConfig {
  providers: {
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    codex?: ProviderConfig
  }
  defaultProvider?: string
  defaultModel?: string
  updatedAt?: string
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as AppConfig
  } catch {
    return { providers: {} }
  }
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  config.updatedAt = new Date().toISOString()
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Returns config stripped of all secrets — safe for sending to client.
 * Secrets are replaced with '***' to indicate presence.
 */
export function sanitizeConfig(config: AppConfig): AppConfig {
  const sanitized: AppConfig = {
    providers: {},
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  }

  for (const [provider, cfg] of Object.entries(config.providers)) {
    if (!cfg) continue
    const key = provider as keyof AppConfig['providers']
    sanitized.providers[key] = {
      baseUrl: cfg.baseUrl,
      extraHeaders: cfg.extraHeaders,
      systemPrompt: cfg.systemPrompt,
      // Indicate presence without exposing values
      apiKey: cfg.apiKey ? '***' : undefined,
      codexClientId: cfg.codexClientId ? '***' : undefined,
      codexClientSecret: cfg.codexClientSecret ? '***' : undefined,
      codexRefreshToken: cfg.codexRefreshToken ? '***' : undefined,
    }
  }

  return sanitized
}
