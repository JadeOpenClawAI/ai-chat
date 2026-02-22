'use client'

import { useChat as useAIChat } from '@ai-sdk/react';
import { DefaultChatTransport, isDataUIPart } from 'ai';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type {
  ContextCompactionMode,
  ContextCompactedAnnotation,
  ContextStats,
  FileAttachment,
  StreamAnnotation,
  ToolCallMeta,
  ContextAnnotation,
  ToolStateAnnotation,
} from '@/lib/types'
import type { ContextManagementPolicy, ProfileConfig } from '@/lib/config/store'
import { readChatState, writeChatState, clearChatState, broadcastStateUpdate, onCrossTabUpdate } from '@/lib/chatStorage'
import type { ChatState } from '@/lib/chatStorage'
import { convertStoredMessages } from '@/lib/convert-messages'

interface UseChatOptions {
  initialModel?: string
}
const STREAM_UPDATE_THROTTLE_MS = 120

type TokenCountableMessage = {
  parts?: unknown
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
  const parts = Array.isArray(message.parts) ? message.parts : undefined
  const hasParts = !!parts && parts.length > 0

  if (hasParts) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        chunks.push(safeStringify(part))
        continue
      }

      const typed = part as Record<string, unknown>
      if (typed.type === 'text' && typeof typed.text === 'string') {
        chunks.push(typed.text)
        continue
      }

      // v5: tool parts are flat with type 'tool-{name}', input, output
      if (typeof typed.type === 'string' && typed.type.startsWith('tool-')) {
        chunks.push(safeStringify({ input: typed.input, output: typed.output }))
        continue
      }

      // v5: file parts
      if (typed.type === 'file') {
        chunks.push(safeStringify({ url: typed.url, mediaType: typed.mediaType }))
        continue
      }

      chunks.push(safeStringify(part))
    }
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

export function useChat(options: UseChatOptions = {}) {
  const [storageReady, setStorageReady] = useState(false)
  const [model, setModel] = useState<string>(options.initialModel ?? 'claude-sonnet-4-5')
  const [activeProfileId, setActiveProfileId] = useState<string>('anthropic:default')
  const [profiles, setProfiles] = useState<ProfileConfig[]>([])
  const [isAutoRouting, setIsAutoRouting] = useState<boolean>(true)
  const [routingPrimary, setRoutingPrimary] = useState<{ profileId: string; modelId: string } | null>(null)
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const lastSyncedAtRef = useRef<number>(0)
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
  const [chatInput, setChatInput] = useState('')
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
  const [variantsByTurn, setVariantsByTurn] = useState<Record<string, TurnVariants>>({})
  const regenerateInFlightRef = useRef(false)
  const appendInFlightRef = useRef(false)

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

  const handleChatResponse = useCallback((response: Response) => {
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
  }, [contextPolicy.compactionThreshold, contextPolicy.mode, isAutoRouting])
  // v5: onResponse removed from UseChatOptions — use custom fetch to intercept response headers
  const handleChatResponseRef = useRef(handleChatResponse)
  useEffect(() => { handleChatResponseRef.current = handleChatResponse }, [handleChatResponse])
  const chat = useAIChat({
    // Keep token-by-token feel while reducing update pressure for long streams.
    experimental_throttle: STREAM_UPDATE_THROTTLE_MS,

    transport: useMemo(() => new DefaultChatTransport({
      api: '/api/chat',
      fetch: (url, init) =>
        fetch(url as RequestInfo, init).then((response) => {
          handleChatResponseRef.current(response)
          return response
        }),
    }), []),
  })
  const isChatLoading = chat.status === 'streaming' || chat.status === 'submitted'
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
  const thresholdLoggedRef = useRef(false)
  useEffect(() => {
    const thresholdReached = effectiveContextStats.shouldCompact
    const warningReached = contextPolicy.mode === 'off' && effectiveContextStats.percentage >= 0.9
    const shouldLog = thresholdReached || warningReached
    if (shouldLog && !thresholdLoggedRef.current) {
      const source =
        estimatedContextUsed > contextStats.used
          ? 'client-estimate'
          : 'server-measured'
      console.info('[chat] context threshold indicator', {
        mode: contextPolicy.mode,
        source,
        serverUsed: contextStats.used,
        estimatedUsed: estimatedContextUsed,
        effectiveUsed: effectiveContextStats.used,
        limit: effectiveContextStats.limit,
        usageRatio: Number(effectiveContextStats.percentage.toFixed(4)),
        threshold: contextPolicy.compactionThreshold,
        shouldCompact: effectiveContextStats.shouldCompact,
      })
      thresholdLoggedRef.current = true
      return
    }
    if (!shouldLog) {
      thresholdLoggedRef.current = false
    }
  }, [
    contextPolicy.compactionThreshold,
    contextPolicy.mode,
    contextStats.used,
    effectiveContextStats.limit,
    effectiveContextStats.percentage,
    effectiveContextStats.shouldCompact,
    effectiveContextStats.used,
    estimatedContextUsed,
  ])
  const messagesRef = useRef(chat.messages)
  useEffect(() => {
    messagesRef.current = chat.messages
  }, [chat.messages])

  const trimTrailingInjectedError = useCallback((messages: typeof chat.messages) => {
    const next = [...messages]
    while (next.length > 0) {
      const tail = next[next.length - 1]
      const isInjectedError =
        tail?.role === 'assistant' &&
        tail.parts.some(
          (p: { type: string; text?: string }) =>
            p.type === 'text' && p.text?.startsWith('❌ Error:'),
        )
      if (isInjectedError) {
        next.pop()
        continue
      }
      break
    }
    return next
  }, [])

  // ── Restore persisted state from IndexedDB on mount ──────────────────────
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    void readChatState().then((stored) => {
      if (!stored) {
        setStorageReady(true)
        return
      }
      if (stored.messages && stored.messages.length > 0) {
        chat.setMessages(convertStoredMessages(stored.messages) as never)
      }
      if (stored.conversationId) setConversationId(stored.conversationId)
      if (stored.profileId) setActiveProfileId(stored.profileId)
      if (stored.model) setModel(stored.model)
      if (typeof stored.useAutoRouting === 'boolean') setIsAutoRouting(stored.useAutoRouting)
      if (typeof stored.routeToast === 'string') setRouteToast(stored.routeToast)
      if (typeof stored.routeToastKey === 'number') setRouteToastKey(stored.routeToastKey)
      if (stored.variantsByTurn) setVariantsByTurn(stored.variantsByTurn)
      if (stored.updatedAt) lastSyncedAtRef.current = stored.updatedAt
      setStorageReady(true)
    })
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

    if (isAutoRouting && primary) {
      setActiveProfileId(primary.profileId)
      setModel(primary.modelId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoRouting])

  // ── Load profiles & routing defaults (wait for IndexedDB restore first) ──
  useEffect(() => {
    if (!storageReady) return
    void loadSettings()
  }, [loadSettings, storageReady])

  // Refresh settings/routing when returning from settings tab/page.
  useEffect(() => {
    const onFocus = () => {
      void loadSettings()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSettings])

  // ── Stream annotation processor ───────────────────────────────────────────
  // In AI SDK v5, annotations are emitted as data parts (type: `data-${string}`)
  // instead of message.annotations. We read from message.parts.
  const lastAnnotationCountRef = useRef(0)
  const lastAnnotationMsgIdRef = useRef('')
  const pendingCompactedMessagesRef = useRef<ContextCompactedAnnotation['messages'] | null>(null)
  useEffect(() => {
    const lastMessage = chat.messages[chat.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return
    // Reset counter when the assistant message changes
    if (lastMessage.id !== lastAnnotationMsgIdRef.current) {
      lastAnnotationMsgIdRef.current = lastMessage.id
      lastAnnotationCountRef.current = 0
    }
    // Read data parts (type starts with 'data-') from v5 message.parts
    const dataParts = lastMessage.parts.filter(isDataUIPart)
    // Skip if no new data parts since last run
    if (dataParts.length === 0 || dataParts.length === lastAnnotationCountRef.current) return
    // Only process newly appended data parts
    const newDataParts = dataParts.slice(lastAnnotationCountRef.current)
    lastAnnotationCountRef.current = dataParts.length
    for (const dataPart of newDataParts) {
      if (!dataPart.data || typeof dataPart.data !== 'object') continue
      const ann = dataPart.data as StreamAnnotation
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
      } else if (ann.type === 'context-compacted') {
        const compactedAnn = ann as ContextCompactedAnnotation
        pendingCompactedMessagesRef.current = compactedAnn.messages
      }
    }
  }, [chat.messages, contextPolicy.compactionThreshold, contextPolicy.mode])

  useEffect(() => {
    if (isChatLoading) return
    const compactedMessages = pendingCompactedMessagesRef.current
    if (!compactedMessages || compactedMessages.length === 0) return
    pendingCompactedMessagesRef.current = null

    const currentMessages = chat.messages
    const lastAssistant = [...currentMessages].reverse().find(
      (m): m is (typeof currentMessages)[number] & { role: 'assistant' } => m.role === 'assistant',
    )
    if (!lastAssistant) return

    const rebased: Array<Record<string, unknown>> = compactedMessages.map((m) => ({
      id: crypto.randomUUID(),
      role: m.role,
      parts: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : Array.isArray(m.content)
          ? m.content
          : [{ type: 'text', text: String(m.content ?? '') }],
    }))
    rebased.push(lastAssistant as unknown as Record<string, unknown>)
    console.info('[chat] applied server compacted history snapshot', {
      compactedMessageCount: compactedMessages.length,
      finalMessageCount: rebased.length,
      lastAssistantId: lastAssistant.id,
    })
    chat.setMessages(rebased as never)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChatLoading, chat.messages])

  // ── Inject terminal request errors into chat history ──────────────────────
  const lastInjectedErrorRef = useRef<string>('')
  useEffect(() => {
    if (isChatLoading) return
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
        parts: [{ type: 'text', text: `❌ Error: ${errText}` }],
      } as never,
    ])
    if (errText.toLowerCase().includes('codex token refresh failed')) {
      setRouteToast('Codex OAuth needs re-authentication. Reconnect in Settings → Codex profile.')
      setRouteToastKey((k) => k + 1)
      window.setTimeout(() => setRouteToast(''), 15000)
    }
    lastInjectedErrorRef.current = errorSig
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, chat.error, isChatLoading, isRequestStarting, requestSeq])

  /** Extract text content from a v5 UIMessage parts array. */
  const getMessageText = (msg: typeof chat.messages[number]): string =>
    msg.parts
      .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('')

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
      .filter(({ message }) => message.role === 'assistant')
      // Ignore transient empty assistant shells (prevents bogus blank variants like 2/2 on first success).
      .filter(({ message }) => getMessageText(message).trim().length > 0)

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
          const msgText = getMessageText(message)
          if (!isChatLoading && existingByMessage.content !== msgText) {
            next = {
              ...next,
              [turnKey]: {
                ...existing,
                variants: existing.variants.map((v) =>
                  v.messageId === message.id
                    ? {
                        ...v,
                        content: msgText,
                        isError: msgText.startsWith('❌ Error:'),
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
            const msgText = getMessageText(message)
            next = {
              ...next,
              [turnKey]: {
                ...existing,
                variants: existing.variants.map((v) =>
                  v.id === active.id
                    ? {
                        ...v,
                        messageId: message.id,
                        content: msgText,
                        isError: msgText.startsWith('❌ Error:'),
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
        const msgText = getMessageText(message)
        const variant: AssistantVariant = {
          id: crypto.randomUUID(),
          messageId: message.id,
          content: msgText,
          isError: msgText.startsWith('❌ Error:'),
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
  // NOTE: isChatLoading is intentionally in deps so we finalise on stream end.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, isChatLoading, getTurnKeyForIndex])

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
    if (isChatLoading) {
      suppressStaleErrorRef.current = false
      setIsRequestStarting(false)
    }
  }, [isChatLoading])

  // ── Regenerate a specific assistant turn ──────────────────────────────────
  //
  // Regeneration trims the thread back to just before the original user prompt,
  // then re-appends that prompt while preserving the SAME user message ID.
  // This keeps retries grouped into one variant set while still avoiding
  // `reload()` re-entrancy issues.
  //
  const regenerateAssistantAt = useCallback(async (assistantMessageId: string, overrideModel?: string) => {
    if (regenerateInFlightRef.current || appendInFlightRef.current) return
    if (isChatLoading || isRequestStarting) return

    regenerateInFlightRef.current = true
    try {
      const messagesSnapshot = messagesRef.current
      const assistantIndex = messagesSnapshot.findIndex((m) => m.id === assistantMessageId)
      if (assistantIndex < 0) return

      // Guard against retrying while tool-call args are still streaming.
      const targetMessage = messagesSnapshot[assistantIndex]
      const hasPendingToolInvocations = targetMessage.parts.some(
        (p: { type: string; state?: string }) =>
          p.type.startsWith('tool-') &&
          p.state !== 'output-available' &&
          p.state !== 'output-error',
      )
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
      appendInFlightRef.current = true
      try {
        await chat.sendMessage(
          {
            id: sourceUserMessage.id,
            role: 'user',
            parts: sourceUserMessage.parts,
          },
          {
            body: { model: modelToUse, profileId: activeProfileId, useAutoRouting: isAutoRouting, conversationId },
          },
        );
      } finally {
        appendInFlightRef.current = false
      }
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
    if (isChatLoading || isRequestStarting || appendInFlightRef.current) return

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
          { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: trimmed }] },
          { id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: payload.message ?? 'Command applied' }] },
        ] as never)
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
    appendInFlightRef.current = true
    try {
        const msgParts: Array<{ type: string; text?: string; url?: string; mediaType?: string }> = [
        { type: 'text', text: messageContent },
      ]
      for (const a of attachments) {
        msgParts.push({ type: 'file', url: a.url, mediaType: a.contentType as string })
      }
      await chat.sendMessage(
        { role: 'user', parts: msgParts as never },
        {
          body: { model, profileId: activeProfileId, useAutoRouting: isAutoRouting, conversationId },
        },
      );
    } finally {
      appendInFlightRef.current = false
    }
  }, [chat, clearAttachments, conversationId, model, activeProfileId, pendingAttachments, isAutoRouting, markNewRequest, trimTrailingInjectedError, isRequestStarting])

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
    pendingCompactedMessagesRef.current = null
    setContextStats({ used: 0, limit: contextPolicy.maxContextTokens, percentage: 0, shouldCompact: false, wasCompacted: false })
    void clearChatState()
  }, [chat, contextPolicy.maxContextTokens])

  const stop = useCallback(() => {
    setIsRequestStarting(false)
    suppressStaleErrorRef.current = false
    chat.stop()
  }, [chat])

  // ── Persist to IndexedDB (debounced during streaming) ────────────────────
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!storageReady) return
    if (suppressPersistFromStorageRef.current) {
      suppressPersistFromStorageRef.current = false
      return
    }

    const doPersist = () => {
      const updatedAt = Date.now()
      lastSyncedAtRef.current = updatedAt
      const state: ChatState = {
        conversationId,
        messages: chat.messages,
        profileId: activeProfileId,
        model,
        useAutoRouting: isAutoRouting,
        routeToast,
        routeToastKey,
        variantsByTurn,
        updatedAt,
      }
      void writeChatState(state)
      broadcastStateUpdate(state)
    }

    // During streaming, debounce to avoid heavy writes on every chunk
    if (isChatLoading) {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = setTimeout(doPersist, 500)
      return () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current) }
    }

    // When not streaming, persist immediately
    doPersist()
  }, [chat.messages, isChatLoading, conversationId, activeProfileId, model, isAutoRouting, routeToast, routeToastKey, variantsByTurn, storageReady])

  // ── Cross-tab sync via BroadcastChannel ──────────────────────────────────
  useEffect(() => {
    return onCrossTabUpdate((next) => {
      if (!next.updatedAt || next.updatedAt <= lastSyncedAtRef.current) return
      // Ignore writes from other conversations/tabs to prevent model/profile
      // selectors from unexpectedly "snapping back".
      if (next.conversationId && next.conversationId !== conversationId) return
      // Prevent cross-tab echo loops: applying a remote snapshot should not
      // immediately write it back with a newer timestamp.
      suppressPersistFromStorageRef.current = true
      if (next.messages) chat.setMessages(convertStoredMessages(next.messages) as never)
      if (next.profileId) setActiveProfileId(next.profileId)
      if (next.model) setModel(next.model)
      if (typeof next.useAutoRouting === 'boolean') setIsAutoRouting(next.useAutoRouting)
      if (typeof next.routeToast === 'string') setRouteToast(next.routeToast)
      if (typeof next.routeToastKey === 'number') setRouteToastKey(next.routeToastKey)
      if (next.variantsByTurn) setVariantsByTurn(next.variantsByTurn)
      lastSyncedAtRef.current = next.updatedAt
    })
  }, [chat, conversationId])

  const setInputValue = useCallback((value: string) => {
    setChatInput(value)
  }, [])

  const setAutoRoutingMode = useCallback((auto: boolean) => {
    setIsAutoRouting(auto)
    if (auto && routingPrimary) {
      setActiveProfileId(routingPrimary.profileId)
      setModel(routingPrimary.modelId)
    }
  }, [routingPrimary])

  return {
    messages: chat.messages,
    input: chatInput,
    setInput: (e: { target: { value: string } }) => setChatInput(e.target.value),
    setInputValue,
    isLoading: isChatLoading || isRequestStarting,
    stop,
    reload: chat.regenerate,
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
