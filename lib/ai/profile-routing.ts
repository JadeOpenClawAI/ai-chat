import type { LLMProvider, StreamAnnotation } from '@/lib/types'
import type { AppConfig, ProfileConfig, RouteTarget } from '@/lib/config/store'
import { getProfileById } from '@/lib/config/store'

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
Be concise but thorough. Use markdown formatting for structure.`

export interface ConversationSelection {
  conversationId: string
  activeProfileId: string
  activeModelId: string
}

export function getOrCreateConversationSelection(
  config: AppConfig,
  conversationId: string,
): ConversationSelection {
  const existing = config.conversations[conversationId]
  if (existing) {
    return {
      conversationId,
      activeProfileId: existing.activeProfileId,
      activeModelId: existing.activeModelId,
    }
  }

  const primary = config.routing.modelPriority[0] ?? { profileId: config.profiles[0]?.id ?? '', modelId: '' }
  const created: ConversationSelection = {
    conversationId,
    activeProfileId: primary.profileId,
    activeModelId: primary.modelId,
  }
  config.conversations[conversationId] = {
    activeProfileId: created.activeProfileId,
    activeModelId: created.activeModelId,
  }
  return created
}

export function composeEffectiveSystemPrompt(
  profile: ProfileConfig,
  requestSystemPrompt?: string,
): string {
  const parts: string[] = []
  if (profile.requiredFirstSystemPrompt) {
    parts.push(profile.requiredFirstSystemPrompt)
  }

  for (const prompt of profile.systemPrompts) {
    if (!prompt.trim()) continue
    if (profile.requiredFirstSystemPrompt && prompt === profile.requiredFirstSystemPrompt) continue
    parts.push(prompt)
  }

  if (requestSystemPrompt?.trim()) {
    parts.push(requestSystemPrompt)
  }

  return parts.length > 0 ? parts.join('\n\n') : DEFAULT_SYSTEM_PROMPT
}

export function buildAttemptPlan(
  config: AppConfig,
  current: ConversationSelection,
): RouteTarget[] {
  const plan: RouteTarget[] = [
    { profileId: current.activeProfileId, modelId: current.activeModelId },
  ]

  for (const entry of config.routing.modelPriority) {
    if (!plan.some((x) => x.profileId === entry.profileId && x.modelId === entry.modelId)) {
      plan.push(entry)
    }
  }

  return plan.slice(0, Math.max(1, config.routing.maxAttempts))
}

export function resolveProviderForProfile(profile: ProfileConfig): LLMProvider {
  return profile.provider
}

export function parseInChatCommand(input: string):
  | { type: 'profile'; profileId: string }
  | { type: 'model'; modelId: string }
  | { type: 'route-primary'; profileId: string; modelId: string }
  | null {
  const value = input.trim()
  if (!value.startsWith('/')) return null

  const profileMatch = value.match(/^\/profile\s+([^\s]+)$/)
  if (profileMatch) return { type: 'profile', profileId: profileMatch[1]! }

  const modelMatch = value.match(/^\/model\s+([^\s]+)$/)
  if (modelMatch) return { type: 'model', modelId: modelMatch[1]! }

  const routeMatch = value.match(/^\/route\s+primary\s+([^\s]+)\s+([^\s]+)$/)
  if (routeMatch) return { type: 'route-primary', profileId: routeMatch[1]!, modelId: routeMatch[2]! }

  return null
}

export function createAttemptAnnotation(attempt: number, target: RouteTarget, provider: LLMProvider): StreamAnnotation {
  return {
    type: 'route-attempt',
    attempt,
    profileId: target.profileId,
    provider,
    model: target.modelId,
    status: 'starting',
  }
}

export function createFailoverAnnotation(
  attempt: number,
  target: RouteTarget,
  provider: LLMProvider,
  message: string,
): StreamAnnotation {
  return {
    type: 'route-attempt',
    attempt,
    profileId: target.profileId,
    provider,
    model: target.modelId,
    status: 'failed',
    error: message,
  }
}

export function getProfileOrThrow(config: AppConfig, profileId: string): ProfileConfig {
  const profile = getProfileById(config, profileId)
  if (!profile || !profile.enabled) {
    throw new Error(`Profile not found or disabled: ${profileId}`)
  }
  return profile
}
