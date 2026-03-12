// ============================================================
// Shared TypeScript Types
// ============================================================

export type LLMProvider = 'anthropic' | 'anthropic-oauth' | 'openai' | 'codex' | 'xai' | 'google-antigravity' | 'google-gemini-cli';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type ToolState =
  | 'pending'
  | 'running'
  | 'streaming'
  | 'summarizing'
  | 'done'
  | 'error';

export interface ToolCallMeta {
  toolCallId: string;
  toolName: string;
  state: ToolState;
  icon?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  resultSummarized?: boolean;
  resultTokenCount?: number;
}

export interface ContextStats {
  used: number;
  limit: number;
  percentage: number;
  shouldCompact: boolean;
  wasCompacted?: boolean;
  compactionMode?: ContextCompactionMode;
  tokensFreed?: number;
}

export type ContextCompactionMode = 'off' | 'truncate' | 'summary' | 'running-summary';
export type ToolCompactionMode = 'off' | 'summary' | 'truncate';

export interface FileAttachment {
  id: string;
  name: string;
  type: 'image' | 'document' | 'video';
  mimeType: string;
  size: number;
  /** Base64 data URI (images) */
  dataUrl?: string;
  /** Extracted text content (PDFs, txt, md) */
  textContent?: string;
  /** Preview thumbnail (video first frame) */
  thumbnailUrl?: string;
  /** Video metadata */
  videoMeta?: {
    duration?: number;
    width?: number;
    height?: number;
  };
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: FileAttachment[];
  toolCalls?: ToolCallMeta[];
  createdAt: Date;
  /** Whether this message is part of a compacted summary */
  isSummary?: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: LLMProvider;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
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
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.4-pro',
    name: 'GPT-5.4 Pro',
    provider: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.3-chat-latest',
    name: 'GPT-5.3 Chat Latest',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2-pro',
    name: 'GPT-5.2 Pro',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2-chat-latest',
    name: 'GPT-5.2 Chat Latest',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    provider: 'openai',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    contextWindow: 1047576,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    contextWindow: 1047576,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    provider: 'openai',
    contextWindow: 1047576,
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
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'codex',
    contextWindow: 1050000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.3-chat-latest',
    name: 'GPT-5.3 Chat Latest',
    provider: 'codex',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2-Codex',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.2-chat-latest',
    name: 'GPT-5.2 Chat Latest',
    provider: 'codex',
    contextWindow: 128000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1-Codex',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1-Codex-Max',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1-Codex-Mini',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5-codex',
    name: 'GPT-5-Codex',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    provider: 'codex',
    contextWindow: 400000,
    supportsVision: true,
    supportsTools: true,
  },
  // xAI Grok models
  {
    id: 'grok-4',
    name: 'Grok 4',
    provider: 'xai',
    contextWindow: 256000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'grok-4-fast',
    name: 'Grok 4 Fast',
    provider: 'xai',
    contextWindow: 2000000,
    supportsVision: true,
    supportsTools: true,
  },
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
  // Google Antigravity models (Gemini 3 via Google Cloud OAuth)
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    provider: 'google-antigravity',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (Antigravity)',
    provider: 'google-antigravity',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Antigravity)',
    provider: 'google-antigravity',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  // Google Gemini CLI models (standard Gemini via Cloud Code Assist OAuth)
  {
    id: 'auto-gemini-3',
    name: 'Auto (Gemini 3.1)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'auto-gemini-2.5',
    name: 'Auto (Gemini 2.5)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash (Gemini CLI)',
    provider: 'google-gemini-cli',
    contextWindow: 1000000,
    supportsVision: true,
    supportsTools: true,
  },
];

export const DEFAULT_ALLOWED_MODELS_BY_PROVIDER: Record<LLMProvider, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  'anthropic-oauth': ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  openai: [
    'gpt-5.4',
    'gpt-5.4-pro',
    'gpt-5.3-chat-latest',
    'gpt-5.2',
    'gpt-5.2-pro',
    'gpt-5.2-chat-latest',
    'gpt-5.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
  ],
  codex: [
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.3-chat-latest',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.1',
    'gpt-5-codex',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
  ],
  xai: [
    'grok-4',
    'grok-4-fast',
    'grok-4-1-fast-reasoning',
    'grok-4-1-fast-non-reasoning',
    'grok-code-fast-1',
    'grok-4-fast-reasoning',
    'grok-4-fast-non-reasoning',
    'grok-4-0709',
    'grok-3-mini',
    'grok-3',
  ],
  'google-antigravity': ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'google-gemini-cli': [
    'auto-gemini-3',
    'auto-gemini-2.5',
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
  ],
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  'anthropic-oauth': 'claude-sonnet-4-5',
  openai: 'gpt-5.4',
  codex: 'gpt-5.3-codex',
  xai: 'grok-4-1-fast-non-reasoning',
  'google-antigravity': 'gemini-2.5-pro',
  'google-gemini-cli': 'auto-gemini-3',
};

export function getDefaultAllowedModelsForProvider(provider: LLMProvider): string[] {
  return [...DEFAULT_ALLOWED_MODELS_BY_PROVIDER[provider]];
}

export function getDefaultModelIdForProvider(provider: LLMProvider): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

// Stream annotation types
export interface ToolStateAnnotation {
  type: 'tool-state';
  toolCallId: string;
  state: ToolState;
  toolName: string;
  icon?: string;
  resultSummarized?: boolean;
  error?: string;
}

export interface ContextAnnotation {
  type: 'context-stats';
  used: number;
  limit: number;
  percentage: number;
  wasCompacted: boolean;
  compactionMode?: ContextCompactionMode;
  tokensFreed?: number;
}

export interface ContextCompactedAnnotation {
  type: 'context-compacted';
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string | unknown[];
  }>;
}

export interface RouteAttemptAnnotation {
  type: 'route-attempt';
  attempt: number;
  profileId: string;
  provider: LLMProvider;
  model: string;
  status: 'starting' | 'failed' | 'succeeded';
  error?: string;
}

export type SubAgentState = 'queued' | 'running' | 'done' | 'error';

export interface SubAgentStateAnnotation {
  type: 'sub-agent-state';
  runId: string;
  toolCallId: string;
  toolName: string;
  objective: string;
  depth: number;
  parentRunId?: string;
  parentAgentId?: string;
  parentAgentLabel?: string;
  totalAgents: number;
  completedAgents: number;
  agentId: string;
  label: string;
  task: string;
  state: SubAgentState;
  startedAt?: number;
  finishedAt?: number;
  progress?: string;
  result?: string;
  error?: string;
}

export type StreamAnnotation =
  | ToolStateAnnotation
  | ContextAnnotation
  | ContextCompactedAnnotation
  | RouteAttemptAnnotation
  | SubAgentStateAnnotation;

// Tool definitions for the registry
export interface ToolDefinition {
  name: string;
  description: string;
  icon: string;
  expectedDurationMs?: number;
  parameters: Record<string, unknown>;
}
