'use client'

import { useChat as useAIChat } from 'ai/react'
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type {
  ContextCompactionMode,
  ContextStats,
  FileAttachment,
  StreamAnnotation,
  ToolCallMeta,
  ContextAnnotation,
  ToolStateAnnotation,
} from '@/lib/types'
import type { ContextManagementPolicy, ProfileConfig } from '@/lib/config/store'

interface UseChatOptions {
  initialModel?: string
}

const CHAT_STORAGE_KEY = 'ai-chat:state:v3'

type TokenCountableMessage = {
  content?: unknown
  parts?: unknown
  toolInvocations?: unknown
  experimental_attachments?: unknown
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function estimateMessageTokens(message: TokenCountableMessage): number {
  const chunks: string[] = []

  if (typeof message.content === 'string') {
    chunks.push(message.content)
  } else if (message.content != null) {
    chunks.push(safeStringify(message.content))
  }

  if (Array.isArray(message.parts) && message.parts.length > 0) {
    for (const part of message.parts) {
      if (!part || typeof part !== 'object') {
        chunks.push(safeStringify(part))
        continue
      }

      const typed = part as Record<string, unknown>
      if (typed.type === 'text' && typeof typed.text === 'string') {
        chunks.push(typed.text)
        continue
      }

      if (typed.type === 'tool-invocation' && typed.toolInvocation !== undefined) {
        chunks.push(safeStringify(typed.toolInvocation))
        continue
      }

      chunks.push(safeStringify(part))
    }
  } else if (Array.isArray(message.toolInvocations) && message.toolInvocations.length > 0) {
    chunks.push(safeStringify(message.toolInvocations))
  }

  if (Array.isArray(message.experimental_attachments) && message.experimental_attachments.length > 0) {
    chunks.push(safeStringify(message.experimental_attachments))
  }

  return 4 + estimateTokens(chunks.join('\n'))
}

function estimateMessagesTokens(messages: TokenCountableMessage[]): number {
  if (messages.length === 0) return 0

  let total = 3
  for (const message of messages) {
    total += estimateMessageTokens(message)
  }
  return total
}

function parseCompactionMode(value: string | null | undefined): ContextCompactionMode | undefined {
  if (!value) return undefined
  if (value === 'off' || value === 'truncate' || value === 'summary' || value === 'running-summary') return value
  return undefined
}

export interface AssistantVariant {
  id: string
  messageId: string
  content: string
  isError: boolean
  createdAt: number
  requestSeq?: number
  /** Full messages array snapshot up to and including this assistant message (finalised after stream ends) */
  snapshot: unknown[]
}

export interface TurnVariants {
  variants: AssistantVariant[]
  activeVariantId: string
}

function readStoredState(): {
  conversationId?: string
  messages?: unknown[]
  profileId?: string
  model?: string
  useAutoRouting?: boolean
  routeToast?: string
  routeToastKey?: number
  variantsByTurn?: Record<string, TurnVariants>
  updatedAt?: number
} | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as {
      conversationId?: string
      messages?: unknown[]
      profileId?: string
      model?: string
      useAutoRouting?: boolean
      routeToast?: string
      routeToastKey?: number
      variantsByTurn?: Record<string, TurnVariants>
      updatedAt?: number
    }
  } catch {
    return null
  }
}

export function useChat(options: UseChatOptions = {}) {
  const [initialStored] = useState(() => readStoredState())
  const [model, setModel] = useState<string>(initialStored?.model ?? options.initialModel ?? 'claude-sonnet-4-5')
  const [activeProfileId, setActiveProfileId] = useState<string>(initialStored?.profileId ?? 'anthropic:default')
  const [profiles, setProfiles] = useState<ProfileConfig[]>([])
  const [isAutoRouting, setIsAutoRouting] = useState<boolean>(initialStored?.useAutoRouting ?? true)
  const [routingPrimary, setRoutingPrimary] = useState<{ profileId: string; modelId: string } | null>(null)
  const [conversationId] = useState<string>(() => initialStored?.conversationId ?? crypto.randomUUID())
  const lastSyncedAtRef = useRef<number>(initialStored?.updatedAt ?? 0)
  const suppressPersistFromStorageRef = useRef(false)
  const activeProfile = profiles.find((p) => p.id === activeProfileId)
  const availableModelsForProfile = activeProfile?.allowedModels ?? []

  // Keep selected model valid when switching profiles from the UI.
  useEffect(() => {
    if (!activeProfile) return
    if (activeProfile.allowedModels.length === 0) return
    if (!activeProfile.allowedModels.includes(model)) {
      setModel(activeProfile.allowedModels[0])
    }
  }, [activeProfile, model])
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [contextPolicy, setContextPolicy] = useState<ContextManagementPolicy>({
    mode: 'summary',
    maxContextTokens: 150000,
    compactionThreshold: 0.75,
    targetContextRatio: 0.1,
    keepRecentMessages: 10,
    minRecentMessages: 4,
    runningSummaryThreshold: 0.35,
    summaryMaxTokens: 1200,
    transcriptMaxChars: 120000,
  })
  const [contextStats, setContextStats] = useState<ContextStats>({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
  const [toolCallStates, setToolCallStates] = useState<Record<string, ToolCallMeta>>({})
  const [wasCompacted, setWasCompacted] = useState(false)
  const [lastCompactionMode, setLastCompactionMode] = useState<ContextCompactionMode | null>(null)
  const [activeRoute, setActiveRoute] = useState<{ profileId: string; modelId: string } | null>(null)
  const [routeToast, setRouteToast] = useState<string>('')
  const [routeToastKey, setRouteToastKey] = useState(0)
  const [requestSeq, setRequestSeq] = useState(0)
  const requestSeqRef = useRef(0)
  const requestStartedAtRef = useRef(0)
  const suppressStaleErrorRef = useRef(false)
  const [isRequestStarting, setIsRequestStarting] = useState(false)
  const [variantsByTurn, setVariantsByTurn] = useState<Record<string, TurnVariants>>(initialStored?.variantsByTurn ?? {})
  const regenerateInFlightRef = useRef(false)

  /**
   * Returns the stable "turn key" for an assistant message at `index`:
   * the ID of the immediately preceding user message.
   */
  const getTurnKeyForIndex = useCallback((messages: { id: string; role: string }[], index: number) => {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') return messages[i].id
    }
    return `root:${index}`
  }, [])

  const chat = useAIChat({
    api: '/api/chat',
    body: { model, conversationId },
    // Smooth frequent stream updates (especially large tool payloads) to avoid
    // SWR/react nested update pressure while keeping a live typing feel.
    experimental_throttle: 80,
    onResponse: (response) => {
      setIsRequestStarting(false)
      suppressStaleErrorRef.current = false
      const used = Number(response.headers.get('X-Context-Used') ?? '')
      const limit = Number(response.headers.get('X-Context-Limit') ?? '')
      const compacted = response.headers.get('X-Was-Compacted') === 'true'
      const configuredMode = parseCompactionMode(response.headers.get('X-Compaction-Configured-Mode'))
      const configuredThreshold = Number(response.headers.get('X-Compaction-Threshold') ?? '')
      const compactionMode = parseCompactionMode(response.headers.get('X-Compaction-Mode'))
      const tokensFreedHeader = Number(response.headers.get('X-Compaction-Tokens-Freed') ?? '')
      const activeProfile = response.headers.get('X-Active-Profile')
      const activeModel = response.headers.get('X-Active-Model')
      const fallback = response.headers.get('X-Route-Fallback') === 'true'
      const failuresRaw = response.headers.get('X-Route-Failures')

      if (activeProfile && activeModel) {
        setActiveRoute({ profileId: activeProfile, modelId: activeModel })
        // In auto mode (or when fallback occurred), mirror the active route in selectors.
        if (isAutoRouting || fallback) {
          setActiveProfileId(activeProfile)
          setModel(activeModel)
        }
      }
      if (fallback) {
        let details = ''
        if (failuresRaw) {
          try {
            const decoded = JSON.parse(decodeURIComponent(failuresRaw)) as Array<{ profileId: string; modelId: string; error: string }>
            details = decoded.map((f) => `${f.profileId}/${f.modelId}: ${f.error}`).join(' · ')
          } catch {
            details = failuresRaw
          }
        }
        const msg = `Fallback route used${details ? ` (${details})` : ''}`
        setRouteToast(msg)
        setRouteToastKey((k) => k + 1)
        window.setTimeout(() => setRouteToast(''), 15000)
      }

      if (Number.isFinite(used) && Number.isFinite(limit) && used >= 0 && limit > 0) {
        const threshold =
          Number.isFinite(configuredThreshold) && configuredThreshold > 0 && configuredThreshold < 1
            ? configuredThreshold
            : contextPolicy.compactionThreshold
        const activeMode = configuredMode ?? contextPolicy.mode

        setContextPolicy((prev) => ({
          ...prev,
          mode: activeMode,
          compactionThreshold: threshold,
          maxContextTokens: limit,
        }))

        setContextStats({
          used,
          limit,
          percentage: used / limit,
          shouldCompact: activeMode !== 'off' && used / limit >= threshold,
          wasCompacted: compacted,
          compactionMode,
          tokensFreed: Number.isFinite(tokensFreedHeader) ? Math.max(0, tokensFreedHeader) : undefined,
        })
        if (compacted) {
          setWasCompacted(true)
          if (compactionMode) setLastCompactionMode(compactionMode)
        }
      }
    },
  })
  const estimatedContextUsed = useMemo(
    () => estimateMessagesTokens(chat.messages as unknown as TokenCountableMessage[]),
    [chat.messages],
  )
  const effectiveContextStats = useMemo<ContextStats>(() => {
    const limit = contextStats.limit > 0 ? contextStats.limit : contextPolicy.maxContextTokens
    const used = Math.max(contextStats.used, estimatedContextUsed)
    const percentage = limit > 0 ? used / limit : 0
    const shouldCompact = contextPolicy.mode !== 'off' && percentage >= contextPolicy.compactionThreshold
    return {
      ...contextStats,
      used,
      limit,
      percentage,
      shouldCompact,
    }
  }, [contextStats, estimatedContextUsed, contextPolicy])
  const messagesRef = useRef(chat.messages)
  useEffect(() => {
    messagesRef.current = chat.messages
  }, [chat.messages])

  const trimTrailingInjectedError = useCallback((messages: typeof chat.messages) => {
    const next = [...messages]
    while (next.length > 0) {
      const tail = next[next.length - 1]
      if (
        tail?.role === 'assistant' &&
        typeof tail.content === 'string' &&
        tail.content.startsWith('❌ Error:')
      ) {
        next.pop()
        continue
      }
      break
    }
    return next
  }, [])

  // ── Restore persisted messages on mount ────────────────────────────────────
  useEffect(() => {
    if (initialStored?.messages && initialStored.messages.length > 0) {
      chat.setMessages(initialStored.messages as never)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/settings')
    const data = (await res.json()) as {
      config: {
        profiles: ProfileConfig[]
        routing: { modelPriority: { profileId: string; modelId: string }[] }
        contextManagement?: ContextManagementPolicy
      }
    }
    setProfiles(data.config.profiles)
    if (data.config.contextManagement) {
      setContextPolicy(data.config.contextManagement)
      setContextStats((prev) => ({
        ...prev,
        limit: data.config.contextManagement?.maxContextTokens ?? prev.limit,
      }))
    }
    const primary = data.config.routing.modelPriority[0]
    if (primary) {
      setRoutingPrimary(primary)
    }

    const hasStoredSelection = Boolean(initialStored?.profileId && initialStored?.model)
    if ((!hasStoredSelection || isAutoRouting) && primary) {
      setActiveProfileId(primary.profileId)
      setModel(primary.modelId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoRouting])

  // ── Load profiles & routing defaults ──────────────────────────────────────
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // Refresh settings/routing when returning from settings tab/page.
  useEffect(() => {
    const onFocus = () => {
      void loadSettings()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSettings])

  // ── Stream annotation processor ───────────────────────────────────────────
  const lastAnnotationCountRef = useRef(0)
  const lastAnnotationMsgIdRef = useRef('')
  useEffect(() => {
    const lastMessage = chat.messages[chat.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return
    // Reset counter when the assistant message changes
    if (lastMessage.id !== lastAnnotationMsgIdRef.current) {
      lastAnnotationMsgIdRef.current = lastMessage.id
      lastAnnotationCountRef.current = 0
    }
    const annotations = (lastMessage as { annotations?: unknown[] }).annotations ?? []
    // Skip if no new annotations since last run
    if (annotations.length === 0 || annotations.length === lastAnnotationCountRef.current) return
    // Only process newly appended annotations
    const newAnnotations = annotations.slice(lastAnnotationCountRef.current)
    lastAnnotationCountRef.current = annotations.length
    for (const annotation of newAnnotations) {
      if (!annotation || typeof annotation !== 'object') continue
      const ann = annotation as StreamAnnotation
      if (ann.type === 'tool-state') {
        const toolAnn = ann as ToolStateAnnotation
        setToolCallStates((prev) => {
          const existing = prev[toolAnn.toolCallId]
          const next = { toolCallId: toolAnn.toolCallId, toolName: toolAnn.toolName, state: toolAnn.state, icon: toolAnn.icon, resultSummarized: toolAnn.resultSummarized, error: toolAnn.error }
          // Skip update if nothing changed
          if (existing && existing.state === next.state && existing.error === next.error && existing.resultSummarized === next.resultSummarized) return prev
          return { ...prev, [toolAnn.toolCallId]: next }
        })
      } else if (ann.type === 'context-stats') {
        const ctxAnn = ann as ContextAnnotation
        setContextStats({
          used: ctxAnn.used,
          limit: ctxAnn.limit,
          percentage: ctxAnn.percentage,
          shouldCompact: contextPolicy.mode !== 'off' && ctxAnn.percentage >= contextPolicy.compactionThreshold,
          wasCompacted: ctxAnn.wasCompacted,
          compactionMode: ctxAnn.compactionMode,
          tokensFreed: ctxAnn.tokensFreed,
        })
        if (ctxAnn.wasCompacted) {
          setWasCompacted(true)
          if (ctxAnn.compactionMode) setLastCompactionMode(ctxAnn.compactionMode)
        }
      }
    }
  }, [chat.messages, contextPolicy.compactionThreshold, contextPolicy.mode])

  // ── Inject terminal request errors into chat history ──────────────────────
  const lastInjectedErrorRef = useRef<string>('')
  useEffect(() => {
    if (chat.isLoading) return
    if (isRequestStarting) return
    // Right after starting a new request there can be one render where `chat.error`
    // still points to the previous request's failure before loading flips to true.
    if (suppressStaleErrorRef.current) return

    const errText = chat.error?.message?.trim()
    if (!errText) return
    if (chat.messages.length === 0) return
    const currentLast = chat.messages[chat.messages.length - 1]
    // Only inject error bubbles when the latest turn is still waiting on an
    // assistant reply. This avoids flashing stale errors before new responses.
    if (!currentLast || currentLast.role !== 'user') return

    // Scope dedupe to the current turn so identical error text can still appear
    // on a later retry for the same/next user message.
    let lastUserId = ''
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      if (chat.messages[i]?.role === 'user') {
        lastUserId = chat.messages[i]?.id ?? ''
        break
      }
    }
    const errorSig = `${lastUserId}:${errText}:${requestSeq}`
    if (lastInjectedErrorRef.current === errorSig) return

    chat.setMessages([
      ...chat.messages,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `❌ Error: ${errText}`,
      },
    ])
    if (errText.toLowerCase().includes('codex token refresh failed')) {
      setRouteToast('Codex OAuth needs re-authentication. Reconnect in Settings → Codex profile.')
      setRouteToastKey((k) => k + 1)
      window.setTimeout(() => setRouteToast(''), 15000)
    }
    lastInjectedErrorRef.current = errorSig
  // eslint-disable-next-line react-hooks/exhaustive-deps -- chat.messages and chat.setMessages are stable enough; using `chat` object causes effect to fire every render
  }, [chat.messages, chat.error, chat.isLoading, chat.setMessages, isRequestStarting, requestSeq])

  // ── Variant tracking ──────────────────────────────────────────────────────
  //
  // Rules:
  //  1. A new variant is created the FIRST time a message ID appears.
  //  2. When streaming ends (`!isLoading`) the snapshot + content are finalised
  //     so that switching back to this variant restores the full response.
  //  3. The turnKey is the preceding user message ID (stable across retries).
  //
  useEffect(() => {
    const assistants = chat.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'assistant' && typeof message.content === 'string')
      // Ignore transient empty assistant shells (prevents bogus blank variants like 2/2 on first success).
      .filter(({ message }) => String(message.content ?? '').trim().length > 0)

    if (assistants.length === 0) return

    setVariantsByTurn((prev) => {
      let next = prev
      let mutated = false
      const currentRequestSeq = requestSeqRef.current || requestSeq
      for (const { message, index } of assistants) {
        const turnKey = getTurnKeyForIndex(chat.messages as { id: string; role: string }[], index)
        const existing = next[turnKey]
        const existingByMessage = existing?.variants.find((v) => v.messageId === message.id)

        if (existingByMessage) {
          // Finalise snapshot + content when streaming completes, so that
          // switching back to this variant restores the FULL response.
          if (!chat.isLoading && existingByMessage.content !== String(message.content ?? '')) {
            next = {
              ...next,
              [turnKey]: {
                ...existing,
                variants: existing.variants.map((v) =>
                  v.messageId === message.id
                    ? {
                        ...v,
                        content: String(message.content ?? ''),
                        isError: String(message.content ?? '').startsWith('❌ Error:'),
                        snapshot: chat.messages.slice(0, index + 1),
                      }
                    : v,
                ),
              },
            }
            mutated = true
          }
          continue
        }

        // Same request, same turn, new assistant message id (tool-step boundary):
        // replace the active variant instead of appending a fake "new variant".
        if (existing) {
          const active = existing.variants.find((v) => v.id === existing.activeVariantId)
          if (active && active.requestSeq === currentRequestSeq) {
            next = {
              ...next,
              [turnKey]: {
                ...existing,
                variants: existing.variants.map((v) =>
                  v.id === active.id
                    ? {
                        ...v,
                        messageId: message.id,
                        content: String(message.content ?? ''),
                        isError: String(message.content ?? '').startsWith('❌ Error:'),
                        snapshot: chat.messages.slice(0, index + 1),
                      }
                    : v,
                ),
              },
            }
            mutated = true
            continue
          }
        }

        // First encounter – create the variant record.
        const variant: AssistantVariant = {
          id: crypto.randomUUID(),
          messageId: message.id,
          content: String(message.content ?? ''),
          isError: String(message.content ?? '').startsWith('❌ Error:'),
          createdAt: Date.now(),
          requestSeq: currentRequestSeq,
          snapshot: chat.messages.slice(0, index + 1),
        }

        if (existing) {
          next = {
            ...next,
            [turnKey]: {
              variants: [...existing.variants, variant],
              activeVariantId: variant.id,
            },
          }
          mutated = true
        } else {
          next = {
            ...next,
            [turnKey]: {
              variants: [variant],
              activeVariantId: variant.id,
            },
          }
          mutated = true
        }
      }
      // Cleanup: drop blank variants and normalize activeVariantId.
      const cleaned: Record<string, TurnVariants> = {}
      for (const [turnKey, turn] of Object.entries(next)) {
        const variants = turn.variants.filter((v) => (v.content ?? '').trim().length > 0)
        if (variants.length === 0) {
          mutated = true
          continue
        }
        const activeExists = variants.some((v) => v.id === turn.activeVariantId)
        const activeVariantId = activeExists ? turn.activeVariantId : variants[variants.length - 1].id
        if (variants.length !== turn.variants.length || activeVariantId !== turn.activeVariantId) {
          mutated = true
        }
        cleaned[turnKey] = {
          variants,
          activeVariantId,
        }
      }

      if (!mutated) return prev
      return cleaned
    })
  // NOTE: chat.isLoading is intentionally in deps so we finalise on stream end.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, chat.isLoading, getTurnKeyForIndex])

  // ── assistantVariantMeta ──────────────────────────────────────────────────
  const assistantVariantMeta = useMemo(() => {
    const meta: Record<string, { turnKey: string; variantIndex: number; variantCount: number }> = {}
    chat.messages.forEach((message, index) => {
      if (message.role !== 'assistant') return
      const turnKey = getTurnKeyForIndex(chat.messages as { id: string; role: string }[], index)
      const turn = variantsByTurn[turnKey]
      if (!turn) return
      const idx = turn.variants.findIndex((v) => v.messageId === message.id)
      if (idx === -1) return
      meta[message.id] = { turnKey, variantIndex: idx, variantCount: turn.variants.length }
    })
    return meta
  }, [chat.messages, getTurnKeyForIndex, variantsByTurn])

  const hiddenAssistantMessageIds = useMemo(() => {
    const hidden = new Set<string>()
    for (const turn of Object.values(variantsByTurn)) {
      const active = turn.variants.find((v) => v.id === turn.activeVariantId)
      for (const v of turn.variants) {
        if (active && v.messageId !== active.messageId) hidden.add(v.messageId)
      }
    }
    return Array.from(hidden)
  }, [variantsByTurn])

  // ── Switch to a different variant (updates downstream thread) ─────────────
  const switchAssistantVariant = useCallback((turnKey: string, direction: -1 | 1) => {
    const turn = variantsByTurn[turnKey]
    if (!turn || turn.variants.length < 2) return
    const currentIndex = Math.max(
      0,
      turn.variants.findIndex((v) => v.id === turn.activeVariantId),
    )
    const nextIndex = currentIndex + direction
    if (nextIndex < 0 || nextIndex >= turn.variants.length) return
    const nextVariant = turn.variants[nextIndex]

    // Restoring the snapshot also clears any downstream messages – this is
    // intentional: the active variant controls the downstream thread.
    chat.setMessages(nextVariant.snapshot as never)
    setVariantsByTurn((prev) => ({
      ...prev,
      [turnKey]: {
        ...turn,
        activeVariantId: nextVariant.id,
      },
    }))
  }, [chat, variantsByTurn])

  const markNewRequest = useCallback(() => {
    suppressStaleErrorRef.current = true
    setIsRequestStarting(true)
    requestStartedAtRef.current = Date.now()
    requestSeqRef.current += 1
    setRequestSeq(requestSeqRef.current)
  }, [])

  useEffect(() => {
    if (!isRequestStarting) return
    const timer = window.setTimeout(() => {
      setIsRequestStarting(false)
      suppressStaleErrorRef.current = false
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [isRequestStarting, requestSeq])

  useEffect(() => {
    if (chat.isLoading) {
      suppressStaleErrorRef.current = false
      setIsRequestStarting(false)
    }
  }, [chat.isLoading])

  // ── Regenerate a specific assistant turn ──────────────────────────────────
  //
  // Regeneration trims the thread back to just before the original user prompt,
  // then re-appends that prompt while preserving the SAME user message ID.
  // This keeps retries grouped into one variant set while still avoiding
  // `reload()` re-entrancy issues.
  //
  const regenerateAssistantAt = useCallback(async (assistantMessageId: string, overrideModel?: string) => {
    if (regenerateInFlightRef.current) return
    if (chat.isLoading || isRequestStarting) return

    regenerateInFlightRef.current = true
    try {
      const messagesSnapshot = messagesRef.current
      const assistantIndex = messagesSnapshot.findIndex((m) => m.id === assistantMessageId)
      if (assistantIndex < 0) return

      // Guard against retrying while tool-call args are still streaming.
      const targetMessage = messagesSnapshot[assistantIndex] as { toolInvocations?: Array<{ state?: string }> }
      const hasPendingToolInvocations =
        Array.isArray(targetMessage.toolInvocations) &&
        targetMessage.toolInvocations.some((ti) => ti?.state !== 'result')
      if (hasPendingToolInvocations) return

      // Walk backward to confirm there is a preceding user message.
      let userIndex = assistantIndex - 1
      while (userIndex >= 0 && messagesSnapshot[userIndex].role !== 'user') {
        userIndex -= 1
      }
      if (userIndex < 0) return

      const sourceUserMessage = messagesSnapshot[userIndex]
      if (!sourceUserMessage || sourceUserMessage.role !== 'user') return

      // Keep history only up to before the source user prompt.
      const truncated = messagesSnapshot.slice(0, userIndex)
      chat.stop()
      chat.setMessages(truncated)

      // Let React commit `setMessages` before starting the next streamed request.
      await new Promise<void>((r) => setTimeout(r, 0))

      const modelToUse = overrideModel ?? model
      markNewRequest()
      await chat.append(
        {
          id: sourceUserMessage.id,
          role: 'user',
          content: sourceUserMessage.content,
          experimental_attachments: sourceUserMessage.experimental_attachments,
        },
        {
          body: { model: modelToUse, profileId: activeProfileId, useAutoRouting: isAutoRouting, conversationId },
        },
      )
    } finally {
      regenerateInFlightRef.current = false
    }
  }, [activeProfileId, chat, conversationId, model, isAutoRouting, markNewRequest, isRequestStarting])

  // ── Attachment helpers ────────────────────────────────────────────────────
  const addAttachment = useCallback((file: FileAttachment) => setPendingAttachments((prev) => [...prev, file]), [])
  const removeAttachment = useCallback((id: string) => setPendingAttachments((prev) => prev.filter((f) => f.id !== id)), [])
  const clearAttachments = useCallback(() => setPendingAttachments([]), [])

  // ── Send a new message ────────────────────────────────────────────────────
  const sendMessage = useCallback(async (content: string) => {
    const sanitizedMessages = trimTrailingInjectedError(chat.messages)
    if (sanitizedMessages.length !== chat.messages.length) {
      chat.setMessages(sanitizedMessages as never)
    }

    const trimmed = content.trim()
    if (trimmed.startsWith('/')) {
      const commandRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...sanitizedMessages, { role: 'user', content: trimmed }],
          model,
          profileId: activeProfileId,
          conversationId,
        }),
      })
      const payload = (await commandRes.json()) as {
        command?: boolean
        commandHandled?: boolean
        message?: string
        state?: { activeProfileId: string; activeModelId: string }
      }
      if (payload.command || payload.commandHandled) {
        chat.setMessages([
          ...sanitizedMessages,
          { id: crypto.randomUUID(), role: 'user', content: trimmed },
          { id: crypto.randomUUID(), role: 'assistant', content: payload.message ?? 'Command applied' },
        ])
        if (payload.state) {
          setActiveProfileId(payload.state.activeProfileId)
          setModel(payload.state.activeModelId)
        }
        return
      }
    }

    let messageContent = content
    if (pendingAttachments.length > 0) {
      const textAttachments = pendingAttachments.filter((a) => a.type === 'document' && a.textContent).map((a) => `\n\n[File: ${a.name}]\n\`\`\`\n${a.textContent}\n\`\`\``).join('')
      messageContent = content + textAttachments
    }

    const attachments = pendingAttachments.filter((a) => a.type === 'image' && a.dataUrl).map((a) => ({ name: a.name, contentType: a.mimeType as `${string}/${string}`, url: a.dataUrl! }))
    clearAttachments()
    markNewRequest()
    await chat.append(
      { role: 'user', content: messageContent },
      {
        experimental_attachments: attachments.length > 0 ? attachments : undefined,
        body: { model, profileId: activeProfileId, useAutoRouting: isAutoRouting, conversationId },
      },
    )
  }, [chat, clearAttachments, conversationId, model, activeProfileId, pendingAttachments, isAutoRouting, markNewRequest, trimTrailingInjectedError])

  // ── Clear conversation ────────────────────────────────────────────────────
  const clearConversation = useCallback(() => {
    chat.setMessages([])
    setToolCallStates({})
    setVariantsByTurn({})
    setRouteToast('')
    lastInjectedErrorRef.current = ''
    setIsRequestStarting(false)
    requestStartedAtRef.current = 0
    setWasCompacted(false)
    setLastCompactionMode(null)
    setContextStats({ used: 0, limit: contextPolicy.maxContextTokens, percentage: 0, shouldCompact: false, wasCompacted: false })
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CHAT_STORAGE_KEY)
    }
  }, [chat, contextPolicy.maxContextTokens])

  const stop = useCallback(() => {
    setIsRequestStarting(false)
    suppressStaleErrorRef.current = false
    chat.stop()
  }, [chat])

  // ── Persist to localStorage (debounced during streaming) ─────────────────
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (suppressPersistFromStorageRef.current) {
      suppressPersistFromStorageRef.current = false
      return
    }

    const doPersist = () => {
      const updatedAt = Date.now()
      lastSyncedAtRef.current = updatedAt
      window.localStorage.setItem(
        CHAT_STORAGE_KEY,
        JSON.stringify({
          conversationId,
          messages: chat.messages,
          profileId: activeProfileId,
          model,
          useAutoRouting: isAutoRouting,
          routeToast,
          routeToastKey,
          variantsByTurn,
          updatedAt,
        }),
      )
    }

    // During streaming, debounce to avoid JSON.stringify on every chunk
    if (chat.isLoading) {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = setTimeout(doPersist, 500)
      return () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current) }
    }

    // When not streaming, persist immediately
    doPersist()
  }, [chat.messages, chat.isLoading, conversationId, activeProfileId, model, isAutoRouting, routeToast, routeToastKey, variantsByTurn])

  // ── Cross-tab sync ────────────────────────────────────────────────────────
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (ev.key !== CHAT_STORAGE_KEY || !ev.newValue) return
      try {
        const next = JSON.parse(ev.newValue) as {
          conversationId?: string
          messages?: unknown[]
          profileId?: string
          model?: string
          useAutoRouting?: boolean
          routeToast?: string
          routeToastKey?: number
          variantsByTurn?: Record<string, TurnVariants>
          updatedAt?: number
        }
        if (!next.updatedAt || next.updatedAt <= lastSyncedAtRef.current) return
        // Ignore writes from other conversations/tabs to prevent model/profile
        // selectors from unexpectedly "snapping back".
        if (next.conversationId && next.conversationId !== conversationId) return
        // Prevent cross-tab echo loops: applying a remote snapshot should not
        // immediately write it back with a newer timestamp.
        suppressPersistFromStorageRef.current = true
        if (next.messages) chat.setMessages(next.messages as never)
        if (next.profileId) setActiveProfileId(next.profileId)
        if (next.model) setModel(next.model)
        if (typeof next.useAutoRouting === 'boolean') {
          setIsAutoRouting(next.useAutoRouting)
        }
        if (typeof next.routeToast === 'string') setRouteToast(next.routeToast)
        if (typeof next.routeToastKey === 'number') setRouteToastKey(next.routeToastKey)
        if (next.variantsByTurn) setVariantsByTurn(next.variantsByTurn)
        lastSyncedAtRef.current = next.updatedAt
      } catch {
        // ignore malformed storage payloads
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [chat, conversationId])

  const setInputValue = useCallback((value: string) => {
    chat.handleInputChange({ target: { value } } as never)
  }, [chat])

  const setAutoRoutingMode = useCallback((auto: boolean) => {
    setIsAutoRouting(auto)
    if (auto && routingPrimary) {
      setActiveProfileId(routingPrimary.profileId)
      setModel(routingPrimary.modelId)
    }
  }, [routingPrimary])

  return {
    messages: chat.messages,
    input: chat.input,
    setInput: chat.handleInputChange,
    setInputValue,
    isLoading: chat.isLoading || isRequestStarting,
    stop,
    reload: chat.reload,
    error: chat.error,
    sendMessage,
    clearConversation,
    model,
    setModel,
    activeProfileId,
    setActiveProfileId,
    profileId: activeProfileId,
    setProfileId: setActiveProfileId,
    profiles,
    availableModelsForProfile,
    isAutoRouting,
    setIsAutoRouting: setAutoRoutingMode,
    activeRoute,
    routeToast,
    routeToastKey,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    contextStats: effectiveContextStats,
    contextPolicy,
    wasCompacted,
    compactionMode: lastCompactionMode,
    toolCallStates,
    assistantVariantMeta,
    hiddenAssistantMessageIds,
    switchAssistantVariant,
    regenerateAssistantAt,
  }
}
