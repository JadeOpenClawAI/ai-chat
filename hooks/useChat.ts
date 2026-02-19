'use client'

import { useChat as useAIChat } from 'ai/react'
import { useState, useCallback, useEffect } from 'react'
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

export function useChat(options: UseChatOptions = {}) {
  const [model, setModel] = useState<string>(options.initialModel ?? 'claude-sonnet-4-5')
  const [activeProfileId, setActiveProfileId] = useState<string>('anthropic:default')
  const [profiles, setProfiles] = useState<ProfileConfig[]>([])
  const [conversationId] = useState<string>(() => crypto.randomUUID())
  const activeProfile = profiles.find((p) => p.id === activeProfileId)
  const availableModelsForProfile = activeProfile?.allowedModels ?? []
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [contextStats, setContextStats] = useState<ContextStats>({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
  const [toolCallStates, setToolCallStates] = useState<Record<string, ToolCallMeta>>({})
  const [wasCompacted, setWasCompacted] = useState(false)

  const chat = useAIChat({
    api: '/api/chat',
    body: { model, conversationId },
    onResponse: (response) => {
      const p = response.headers.get('X-Active-Profile-Id')
      const m = response.headers.get('X-Active-Model-Id')
      if (p) setActiveProfileId(p)
      if (m) setModel(m)
    },
  })

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings')
      const data = (await res.json()) as { profiles: ProfileConfig[]; routing: { primary: { profileId: string; modelId: string } } }
      setProfiles(data.profiles)
      setActiveProfileId(data.routing.primary.profileId)
      setModel(data.routing.primary.modelId)
    })()
  }, [])

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

  const addAttachment = useCallback((file: FileAttachment) => setPendingAttachments((prev) => [...prev, file]), [])
  const removeAttachment = useCallback((id: string) => setPendingAttachments((prev) => prev.filter((f) => f.id !== id)), [])
  const clearAttachments = useCallback(() => setPendingAttachments([]), [])

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (trimmed.startsWith('/')) {
      const commandRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...chat.messages, { role: 'user', content: trimmed }],
          model,
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
    await chat.append({ role: 'user', content: messageContent }, { experimental_attachments: attachments.length > 0 ? attachments : undefined, body: { model, conversationId } })
  }, [chat, clearAttachments, conversationId, model, pendingAttachments])

  const clearConversation = useCallback(() => {
    chat.setMessages([])
    setToolCallStates({})
    setWasCompacted(false)
    setContextStats({ used: 0, limit: 150000, percentage: 0, shouldCompact: false, wasCompacted: false })
  }, [chat])

  return {
    messages: chat.messages,
    input: chat.input,
    setInput: chat.handleInputChange,
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
  }
}
