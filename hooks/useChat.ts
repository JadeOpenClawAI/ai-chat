// ============================================================
// Extended useChat hook
// Wraps Vercel AI SDK useChat with context stats + file uploads
// ============================================================

'use client'

import { useChat as useAIChat } from 'ai/react'
import { useState, useCallback, useEffect } from 'react'
import type {
  ContextStats,
  FileAttachment,
  LLMProvider,
  StreamAnnotation,
  ToolCallMeta,
  ContextAnnotation,
  ToolStateAnnotation,
} from '@/lib/types'

interface UseChatOptions {
  initialProvider?: LLMProvider
  initialModel?: string
}

export function useChat(options: UseChatOptions = {}) {
  const [provider, setProvider] = useState<LLMProvider>(
    options.initialProvider ?? 'anthropic',
  )
  const [model, setModel] = useState<string>(
    options.initialModel ?? 'claude-sonnet-4-5',
  )
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [contextStats, setContextStats] = useState<ContextStats>({
    used: 0,
    limit: 150000,
    percentage: 0,
    shouldCompact: false,
    wasCompacted: false,
  })
  const [toolCallStates, setToolCallStates] = useState<
    Record<string, ToolCallMeta>
  >({})
  const [wasCompacted, setWasCompacted] = useState(false)

  const chat = useAIChat({
    api: '/api/chat',
    body: {
      provider,
      model,
    },
    onResponse: (response) => {
      // Read context stats from response headers
      const used = parseInt(response.headers.get('X-Context-Used') ?? '0', 10)
      const limit = parseInt(response.headers.get('X-Context-Limit') ?? '150000', 10)
      const compacted = response.headers.get('X-Was-Compacted') === 'true'
      if (used > 0) {
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
    onError: (error) => {
      console.error('[useChat] Error:', error)
    },
  })

  // Parse stream annotations for tool state + context updates
  useEffect(() => {
    const lastMessage = chat.messages[chat.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return

    const annotations = (lastMessage as { annotations?: unknown[] }).annotations ?? []

    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== 'object') continue
      const ann = annotation as StreamAnnotation

      if (ann.type === 'tool-state') {
        const toolAnn = ann as ToolStateAnnotation
        setToolCallStates((prev) => ({
          ...prev,
          [toolAnn.toolCallId]: {
            toolCallId: toolAnn.toolCallId,
            toolName: toolAnn.toolName,
            state: toolAnn.state,
            icon: toolAnn.icon,
            resultSummarized: toolAnn.resultSummarized,
            error: toolAnn.error,
          },
        }))
      } else if (ann.type === 'context-stats') {
        const ctxAnn = ann as ContextAnnotation
        setContextStats({
          used: ctxAnn.used,
          limit: ctxAnn.limit,
          percentage: ctxAnn.percentage,
          shouldCompact: ctxAnn.percentage >= 0.8,
          wasCompacted: ctxAnn.wasCompacted,
        })
        if (ctxAnn.wasCompacted) setWasCompacted(true)
      }
    }
  }, [chat.messages])

  // ── File attachment helpers ──────────────────────────────

  const addAttachment = useCallback((file: FileAttachment) => {
    setPendingAttachments((prev) => [...prev, file])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const clearAttachments = useCallback(() => {
    setPendingAttachments([])
  }, [])

  // ── Send with attachments ────────────────────────────────

  const sendMessage = useCallback(
    async (content: string) => {
      // Build the message content with any attachments
      let messageContent: string = content

      if (pendingAttachments.length > 0) {
        // Append file content as text for non-image files
        const textAttachments = pendingAttachments
          .filter((a) => a.type === 'document' && a.textContent)
          .map(
            (a) =>
              `\n\n[File: ${a.name}]\n\`\`\`\n${a.textContent}\n\`\`\``,
          )
          .join('')

        messageContent = content + textAttachments
      }

      // For images, we'd attach them as multimodal content
      // Vercel AI SDK useChat handles experimental_attachments for this
      const attachments = pendingAttachments
        .filter((a) => a.type === 'image' && a.dataUrl)
        .map((a) => ({
          name: a.name,
          contentType: a.mimeType as `${string}/${string}`,
          url: a.dataUrl!,
        }))

      clearAttachments()

      await chat.append(
        { role: 'user', content: messageContent },
        {
          experimental_attachments: attachments.length > 0 ? attachments : undefined,
          body: { provider, model },
        },
      )
    },
    [pendingAttachments, chat, provider, model, clearAttachments],
  )

  const clearConversation = useCallback(() => {
    chat.setMessages([])
    setToolCallStates({})
    setWasCompacted(false)
    setContextStats({
      used: 0,
      limit: 150000,
      percentage: 0,
      shouldCompact: false,
      wasCompacted: false,
    })
  }, [chat])

  return {
    // From Vercel AI SDK
    messages: chat.messages,
    input: chat.input,
    setInput: chat.handleInputChange,
    isLoading: chat.isLoading,
    stop: chat.stop,
    reload: chat.reload,
    error: chat.error,

    // Enhanced
    sendMessage,
    clearConversation,

    // Provider/model selection
    provider,
    setProvider,
    model,
    setModel,

    // File attachments
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,

    // Context management
    contextStats,
    wasCompacted,

    // Tool state
    toolCallStates,
  }
}
