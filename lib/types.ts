// ============================================================
// Shared TypeScript Types
// ============================================================

export type LLMProvider = 'anthropic' | 'openai' | 'codex'

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
}

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
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'claude-haiku-3-5',
    name: 'Claude Haiku 3.5',
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
    id: 'codex-mini-latest',
    name: 'Codex Mini (Latest)',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: false,
    supportsTools: true,
  },
  {
    id: 'o3',
    name: 'o3',
    provider: 'codex',
    contextWindow: 200000,
    supportsVision: false,
    supportsTools: true,
  },
  {
    id: 'o4-mini',
    name: 'o4-mini',
    provider: 'codex',
    contextWindow: 200000,
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

export type StreamAnnotation = ToolStateAnnotation | ContextAnnotation | RouteAttemptAnnotation

// Tool definitions for the registry
export interface ToolDefinition {
  name: string
  description: string
  icon: string
  expectedDurationMs?: number
  parameters: Record<string, unknown>
}
