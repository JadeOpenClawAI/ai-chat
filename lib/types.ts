// ============================================================
// Shared TypeScript Types
// ============================================================

export type LLMProvider = 'anthropic' | 'anthropic-oauth' | 'openai' | 'codex' | 'xai'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type ToolState =
  | 'pending'
  | 'running'
  | 'streaming'
  | 'summarizing'
  | 'done'
  | 'error'

export interface ToolCallMeta {
  toolCallId: string
  toolName: string
  state: ToolState
  icon?: string
  startedAt?: number
  finishedAt?: number
  error?: string
  resultSummarized?: boolean
  resultTokenCount?: number
}

export interface ContextStats {
  used: number
  limit: number
  percentage: number
  shouldCompact: boolean
  wasCompacted?: boolean
  compactionMode?: ContextCompactionMode
  tokensFreed?: number
}

export type ContextCompactionMode = 'off' | 'truncate' | 'summary' | 'running-summary'
export type ToolCompactionMode = 'off' | 'summary' | 'truncate'

export interface FileAttachment {
  id: string
  name: string
  type: 'image' | 'document' | 'video'
  mimeType: string
  size: number
  /** Base64 data URI (images) */
  dataUrl?: string
  /** Extracted text content (PDFs, txt, md) */
  textContent?: string
  /** Preview thumbnail (video first frame) */
  thumbnailUrl?: string
  /** Video metadata */
  videoMeta?: {
    duration?: number
    width?: number
    height?: number
  }
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  attachments?: FileAttachment[]
  toolCalls?: ToolCallMeta[]
  createdAt: Date
  /** Whether this message is part of a compacted summary */
  isSummary?: boolean
}

export interface ModelOption {
  id: string
  name: string
  provider: LLMProvider
  contextWindow: number
  supportsVision: boolean
  supportsTools: boolean
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: false,
    supportsTools: true,
  },
  // OpenAI Codex models (OAuth-based)
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2-Codex',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1-Codex-Max',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1-Codex-Mini',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  // xAI Grok models
  {
    id: 'grok-4-1-fast-reasoning',
    name: 'Grok 4.1 Fast Reasoning',
    provider: 'xai',
    contextWindow: 2000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-4-1-fast-non-reasoning',
    name: 'Grok 4.1 Fast Non-Reasoning',
    provider: 'xai',
    contextWindow: 2000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-code-fast-1',
    name: 'Grok Code Fast 1',
    provider: 'xai',
    contextWindow: 256000,
    supportsVision: false,
    supportsTools: true,
  },
  {
    id: 'grok-4-fast-reasoning',
    name: 'Grok 4 Fast Reasoning',
    provider: 'xai',
    contextWindow: 2000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-4-fast-non-reasoning',
    name: 'Grok 4 Fast Non-Reasoning',
    provider: 'xai',
    contextWindow: 2000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-4-0709',
    name: 'Grok 4 0709',
    provider: 'xai',
    contextWindow: 256000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-3-mini',
    name: 'Grok 3 Mini',
    provider: 'xai',
    contextWindow: 131072,
    supportsVision: false,
    supportsTools: true,
  },
  {
    id: 'grok-3',
    name: 'Grok 3',
    provider: 'xai',
    contextWindow: 131072,
    supportsVision: false,
    supportsTools: true,
  },
]

// Stream annotation types
export interface ToolStateAnnotation {
  type: 'tool-state'
  toolCallId: string
  state: ToolState
  toolName: string
  icon?: string
  resultSummarized?: boolean
  error?: string
}

export interface ContextAnnotation {
  type: 'context-stats'
  used: number
  limit: number
  percentage: number
  wasCompacted: boolean
  compactionMode?: ContextCompactionMode
  tokensFreed?: number
}

export interface ContextCompactedAnnotation {
  type: 'context-compacted'
  messages: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string | unknown[]
  }>
}

export interface RouteAttemptAnnotation {
  type: 'route-attempt'
  attempt: number
  profileId: string
  provider: LLMProvider
  model: string
  status: 'starting' | 'failed' | 'succeeded'
  error?: string
}

export type StreamAnnotation = ToolStateAnnotation | ContextAnnotation | ContextCompactedAnnotation | RouteAttemptAnnotation

// Tool definitions for the registry
export interface ToolDefinition {
  name: string
  description: string
  icon: string
  expectedDurationMs?: number
  parameters: Record<string, unknown>
}
