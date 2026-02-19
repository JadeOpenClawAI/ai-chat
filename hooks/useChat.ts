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
  const [conversationId] = useState<string>(() => initialStored?.conversationId ?? crypto.randomUUID())
  const lastSyncedAtRef = useRef<number>(initialStored?.updatedAt ?? 0)
  const activeProfile = profiles.find((p) => p.id === activeProfileId)
  const availableModelsForProfile = activeProfile?.allowedModels ?? []
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [contextStats, setContextStats] = useState<ContextStats>({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
  const [toolCallStates, setToolCallStates] = useState<Record<string, ToolCallMeta>>({})
  const [wasCompacted, setWasCompacted] = useState(false)
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
  })

  // ── Restore persisted messages on mount ────────────────────────────────────
  useEffect(() => {
    if (initialStored?.messages && initialStored.messages.length > 0) {
      chat.setMessages(initialStored.messages as never)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load profiles & routing defaults ──────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings')
      const data = (await res.json()) as { config: { profiles: ProfileConfig[]; routing: { modelPriority: { profileId: string; modelId: string }[] } } }
      setProfiles(data.config.profiles)
      if (!initialStored?.profileId || !initialStored?.model) {
        const primary = data.config.routing.modelPriority[0]
        if (primary) {
          setActiveProfileId(primary.profileId)
          setModel(primary.modelId)
        }
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  useEffect(() => {
    const errText = chat.error?.message?.trim()
    if (!errText) return
    const currentLast = chat.messages[chat.messages.length - 1]
    if (currentLast?.role === 'assistant' && typeof currentLast.content === 'string' && currentLast.content === `❌ Error: ${errText}`) {
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
  }, [chat, chat.error, chat.messages])

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

    if (assistants.length === 0) return

    setVariantsByTurn((prev) => {
      let next = prev
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
        } else {
          next = {
            ...next,
            [turnKey]: {
              variants: [variant],
              activeVariantId: variant.id,
            },
          }
        }
      }
      return next
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
    await chat.reload({ body: { model: modelToUse, profileId: activeProfileId, conversationId } } as never)
  }, [activeProfileId, chat, conversationId, model])

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
    await chat.append({ role: 'user', content: messageContent }, { experimental_attachments: attachments.length > 0 ? attachments : undefined, body: { model, profileId: activeProfileId, conversationId } })
  }, [chat, clearAttachments, conversationId, model, activeProfileId, pendingAttachments])

  // ── Clear conversation ────────────────────────────────────────────────────
  const clearConversation = useCallback(() => {
    chat.setMessages([])
    setToolCallStates({})
    setVariantsByTurn({})
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
        variantsByTurn,
        updatedAt,
      }),
    )
  }, [chat.messages, conversationId, activeProfileId, model, variantsByTurn])

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
          variantsByTurn?: Record<string, TurnVariants>
          updatedAt?: number
        }
        if (!next.updatedAt || next.updatedAt <= lastSyncedAtRef.current) return
        if (next.messages) chat.setMessages(next.messages as never)
        if (next.profileId) setActiveProfileId(next.profileId)
        if (next.model) setModel(next.model)
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
    routeStatus: '',
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    contextStats,
    wasCompacted,
    toolCallStates,
    assistantVariantMeta,
    switchAssistantVariant,
    regenerateAssistantAt,
  }
}
