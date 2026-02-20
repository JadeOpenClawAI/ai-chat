'use client'

import { useChat as useAIChat } from 'ai/react'
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type {
  ContextStats,
  FileAttachment,
  StreamAnnotation,
  ToolCallMeta,
  ContextAnnotation,
  ToolStateAnnotation,
} from '@/lib/types'
import type { ProfileConfig } from '@/lib/config/store'

interface UseChatOptions {
  initialModel?: string
}

const CHAT_STORAGE_KEY = 'ai-chat:state:v3'

export interface AssistantVariant {
  id: string
  messageId: string
  content: string
  isError: boolean
  createdAt: number
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
  useManualRouting?: boolean
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
      useManualRouting?: boolean
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
  const initialStored = readStoredState()
  const [model, setModel] = useState<string>(initialStored?.model ?? options.initialModel ?? 'claude-sonnet-4-5')
  const [activeProfileId, setActiveProfileId] = useState<string>(initialStored?.profileId ?? 'anthropic:default')
  const [profiles, setProfiles] = useState<ProfileConfig[]>([])
  const [useManualRouting, setUseManualRouting] = useState<boolean>(initialStored?.useManualRouting ?? false)
  const [routingPrimary, setRoutingPrimary] = useState<{ profileId: string; modelId: string } | null>(null)
  const [conversationId] = useState<string>(() => initialStored?.conversationId ?? crypto.randomUUID())
  const lastSyncedAtRef = useRef<number>(initialStored?.updatedAt ?? 0)
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
  const [contextStats, setContextStats] = useState<ContextStats>({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
  const [toolCallStates, setToolCallStates] = useState<Record<string, ToolCallMeta>>({})
  const [wasCompacted, setWasCompacted] = useState(false)
  const [activeRoute, setActiveRoute] = useState<{ profileId: string; modelId: string } | null>(null)
  const [routeToast, setRouteToast] = useState<string>('')
  const [routeToastKey, setRouteToastKey] = useState(0)
  const [requestSeq, setRequestSeq] = useState(0)
  const requestSeqRef = useRef(0)
  const [variantsByTurn, setVariantsByTurn] = useState<Record<string, TurnVariants>>(initialStored?.variantsByTurn ?? {})

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
    onResponse: (response) => {
      const used = Number(response.headers.get('X-Context-Used') ?? '')
      const limit = Number(response.headers.get('X-Context-Limit') ?? '')
      const compacted = response.headers.get('X-Was-Compacted') === 'true'
      const activeProfile = response.headers.get('X-Active-Profile')
      const activeModel = response.headers.get('X-Active-Model')
      const fallback = response.headers.get('X-Route-Fallback') === 'true'
      const failuresRaw = response.headers.get('X-Route-Failures')

      if (activeProfile && activeModel) {
        setActiveRoute({ profileId: activeProfile, modelId: activeModel })
        // In auto mode (or when fallback occurred), mirror the active route in selectors.
        if (!useManualRouting || fallback) {
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
        setContextStats({
          used,
          limit,
          percentage: used / limit,
          shouldCompact: used / limit >= 0.8,
          wasCompacted: compacted,
        })
        if (compacted) setWasCompacted(true)
      }
    },
  })

  // ── Restore persisted messages on mount ────────────────────────────────────
  useEffect(() => {
    if (initialStored?.messages && initialStored.messages.length > 0) {
      chat.setMessages(initialStored.messages as never)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/settings')
    const data = (await res.json()) as { config: { profiles: ProfileConfig[]; routing: { modelPriority: { profileId: string; modelId: string }[] } } }
    setProfiles(data.config.profiles)
    const primary = data.config.routing.modelPriority[0]
    if (primary) {
      setRoutingPrimary(primary)
    }

    const hasStoredSelection = Boolean(initialStored?.profileId && initialStored?.model)
    if ((!hasStoredSelection || !useManualRouting) && primary) {
      setActiveProfileId(primary.profileId)
      setModel(primary.modelId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useManualRouting])

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
  useEffect(() => {
    const lastMessage = chat.messages[chat.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return
    const annotations = (lastMessage as { annotations?: unknown[] }).annotations ?? []
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== 'object') continue
      const ann = annotation as StreamAnnotation
      if (ann.type === 'tool-state') {
        const toolAnn = ann as ToolStateAnnotation
        setToolCallStates((prev) => ({ ...prev, [toolAnn.toolCallId]: { toolCallId: toolAnn.toolCallId, toolName: toolAnn.toolName, state: toolAnn.state, icon: toolAnn.icon, resultSummarized: toolAnn.resultSummarized, error: toolAnn.error } }))
      } else if (ann.type === 'context-stats') {
        const ctxAnn = ann as ContextAnnotation
        setContextStats({ used: ctxAnn.used, limit: ctxAnn.limit, percentage: ctxAnn.percentage, shouldCompact: ctxAnn.percentage >= 0.8, wasCompacted: ctxAnn.wasCompacted })
        if (ctxAnn.wasCompacted) setWasCompacted(true)
      }
    }
  }, [chat.messages])

  // ── Inject error placeholder messages ─────────────────────────────────────
  const lastInjectedErrorRef = useRef<string>('')
  useEffect(() => {
    const errText = chat.error?.message?.trim()
    if (!errText) return
    if (chat.messages.length === 0) return

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

    const currentLast = chat.messages[chat.messages.length - 1]
    if (currentLast?.role === 'assistant' && typeof currentLast.content === 'string' && currentLast.content === `❌ Error: ${errText}`) {
      lastInjectedErrorRef.current = errorSig
      return
    }

    chat.setMessages([
      ...chat.messages,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `❌ Error: ${errText}`,
      },
    ])
    lastInjectedErrorRef.current = errorSig
  }, [chat, chat.error, requestSeq])

  // ── Variant tracking ──────────────────────────────────────────────────────
  //
  // Rules:
  //  1. A new variant is created the FIRST time a message ID appears.
  //  2. When streaming ends (`!isLoading`) the snapshot + content are finalised
  //     so that switching back to this variant restores the full response.
  //  3. The turnKey is the preceding user message ID – stable across retries
  //     because `regenerateAssistantAt` now uses `reload` (no new user msg ID).
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

        // First encounter – create the variant record.
        const variant: AssistantVariant = {
          id: crypto.randomUUID(),
          messageId: message.id,
          content: String(message.content ?? ''),
          isError: String(message.content ?? '').startsWith('❌ Error:'),
          createdAt: Date.now(),
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
    requestSeqRef.current += 1
    setRequestSeq(requestSeqRef.current)
  }, [])

  // ── Regenerate a specific assistant turn ──────────────────────────────────
  //
  // Key design: we keep the ORIGINAL user message (same ID = same turnKey).
  // Using `setMessages(…up to assistant) + reload()` avoids creating a new
  // user message, so all retries for the same turn share one turnKey and their
  // variants are grouped under the same navigator.
  //
  const regenerateAssistantAt = useCallback(async (assistantMessageId: string, overrideModel?: string) => {
    // Stop any in-flight stream first.
    if (chat.isLoading) {
      chat.stop()
      // Give the stop a tick to propagate before we mutate messages.
      await new Promise<void>((r) => setTimeout(r, 50))
    }

    const assistantIndex = chat.messages.findIndex((m) => m.id === assistantMessageId)
    if (assistantIndex < 0) return

    // Walk backward to confirm there is a preceding user message.
    let userIndex = assistantIndex - 1
    while (userIndex >= 0 && chat.messages[userIndex].role !== 'user') {
      userIndex -= 1
    }
    if (userIndex < 0) return

    // Slice to include the user message but drop the assistant reply (and anything after).
    const truncated = chat.messages.slice(0, userIndex + 1)
    chat.setMessages(truncated)

    // `reload()` reads from the internal messagesRef which was updated synchronously
    // by `setMessages`, so it will submit the truncated history and stream a new reply.
    const modelToUse = overrideModel ?? model
    markNewRequest()
    await chat.reload({
      body: useManualRouting
        ? { model: modelToUse, profileId: activeProfileId, useManualRouting: true, conversationId }
        : { model: modelToUse, profileId: activeProfileId, useManualRouting: false, conversationId },
    } as never)
  }, [activeProfileId, chat, conversationId, model, useManualRouting, markNewRequest])

  // ── Attachment helpers ────────────────────────────────────────────────────
  const addAttachment = useCallback((file: FileAttachment) => setPendingAttachments((prev) => [...prev, file]), [])
  const removeAttachment = useCallback((id: string) => setPendingAttachments((prev) => prev.filter((f) => f.id !== id)), [])
  const clearAttachments = useCallback(() => setPendingAttachments([]), [])

  // ── Send a new message ────────────────────────────────────────────────────
  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (trimmed.startsWith('/')) {
      const commandRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...chat.messages, { role: 'user', content: trimmed }],
          model,
          profileId: activeProfileId,
          conversationId,
        }),
      })
      const payload = (await commandRes.json()) as { command?: boolean; message?: string; state?: { activeProfileId: string; activeModelId: string } }
      if (payload.command) {
        chat.setMessages([
          ...chat.messages,
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
        body: useManualRouting
          ? { model, profileId: activeProfileId, useManualRouting: true, conversationId }
          : { model, profileId: activeProfileId, useManualRouting: false, conversationId },
      },
    )
  }, [chat, clearAttachments, conversationId, model, activeProfileId, pendingAttachments, useManualRouting, markNewRequest])

  // ── Clear conversation ────────────────────────────────────────────────────
  const clearConversation = useCallback(() => {
    chat.setMessages([])
    setToolCallStates({})
    setVariantsByTurn({})
    setRouteToast('')
    lastInjectedErrorRef.current = ''
    setWasCompacted(false)
    setContextStats({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CHAT_STORAGE_KEY)
    }
  }, [chat])

  // ── Persist to localStorage ───────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const updatedAt = Date.now()
    lastSyncedAtRef.current = updatedAt
    window.localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        conversationId,
        messages: chat.messages,
        profileId: activeProfileId,
        model,
        useManualRouting,
        routeToast,
        routeToastKey,
        variantsByTurn,
        updatedAt,
      }),
    )
  }, [chat.messages, conversationId, activeProfileId, model, useManualRouting, routeToast, routeToastKey, variantsByTurn])

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
          useManualRouting?: boolean
          routeToast?: string
          routeToastKey?: number
          variantsByTurn?: Record<string, TurnVariants>
          updatedAt?: number
        }
        if (!next.updatedAt || next.updatedAt <= lastSyncedAtRef.current) return
        if (next.messages) chat.setMessages(next.messages as never)
        if (next.profileId) setActiveProfileId(next.profileId)
        if (next.model) setModel(next.model)
        if (typeof next.useManualRouting === 'boolean') setUseManualRouting(next.useManualRouting)
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
  }, [chat])

  const setInputValue = useCallback((value: string) => {
    chat.handleInputChange({ target: { value } } as never)
  }, [chat])

  const setRoutingMode = useCallback((manual: boolean) => {
    setUseManualRouting(manual)
    if (!manual && routingPrimary) {
      setActiveProfileId(routingPrimary.profileId)
      setModel(routingPrimary.modelId)
    }
  }, [routingPrimary])

  return {
    messages: chat.messages,
    input: chat.input,
    setInput: chat.handleInputChange,
    setInputValue,
    isLoading: chat.isLoading,
    stop: chat.stop,
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
    useManualRouting,
    setUseManualRouting: setRoutingMode,
    activeRoute,
    routeToast,
    routeToastKey,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    contextStats,
    wasCompacted,
    toolCallStates,
    assistantVariantMeta,
    hiddenAssistantMessageIds,
    switchAssistantVariant,
    regenerateAssistantAt,
  }
}
