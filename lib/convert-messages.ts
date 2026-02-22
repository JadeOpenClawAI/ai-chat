/**
 * Runtime v4↔v5 message conversion layer.
 * Applied when reading from / writing to IndexedDB so old stored messages
 * continue to work after the AI SDK 5 migration.
 *
 * @see https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0-data
 */

import type { ToolInvocation, Message as V4Message, UIMessage as V4UIMessage } from 'ai-legacy'
import type { ToolUIPart, UIMessage } from 'ai'

// ── Types ─────────────────────────────────────────────────────────────────────

type V4Part = NonNullable<V4Message['parts']>[number]

type V4ToolInvocationPart = Extract<V4Part, { type: 'tool-invocation' }>
type V4ReasoningPart = Extract<V4Part, { type: 'reasoning' }>
type V4SourcePart = Extract<V4Part, { type: 'source' }>
type V4FilePart = Extract<V4Part, { type: 'file' }>

// ── Type guards ────────────────────────────────────────────────────────────────

function isV4Message(msg: unknown): msg is V4Message {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  const parts = Array.isArray(m.parts) ? m.parts : []
  return (
    'toolInvocations' in m ||
    parts.some((p: unknown) => (p as Record<string, unknown>)?.type === 'tool-invocation') ||
    m.role === 'data' ||
    ('reasoning' in m && typeof m.reasoning === 'string') ||
    parts.some((p: unknown) => {
      const part = p as Record<string, unknown>
      return 'args' in part || 'result' in part
    }) ||
    parts.some((p: unknown) => {
      const part = p as Record<string, unknown>
      return 'reasoning' in part && 'details' in part
    }) ||
    parts.some((p: unknown) => {
      const part = p as Record<string, unknown>
      return part.type === 'file' && 'mimeType' in part && 'data' in part
    })
  )
}

function isV4ToolInvocationPart(part: unknown): part is V4ToolInvocationPart {
  const p = part as Record<string, unknown>
  return p?.type === 'tool-invocation' && 'toolInvocation' in p
}

function isV4ReasoningPart(part: unknown): part is V4ReasoningPart {
  const p = part as Record<string, unknown>
  return p?.type === 'reasoning' && 'reasoning' in p
}

function isV4SourcePart(part: unknown): part is V4SourcePart {
  const p = part as Record<string, unknown>
  return p?.type === 'source' && 'source' in p
}

function isV4FilePart(part: unknown): part is V4FilePart {
  const p = part as Record<string, unknown>
  return p?.type === 'file' && 'mimeType' in p && 'data' in p
}

// ── State mapping ──────────────────────────────────────────────────────────────

const V4_TO_V5_STATE_MAP = {
  'partial-call': 'input-streaming',
  call: 'input-available',
  result: 'output-available',
} as const

function convertToolState(
  v4State: ToolInvocation['state'],
): 'input-streaming' | 'input-available' | 'output-available' {
  return V4_TO_V5_STATE_MAP[v4State] ?? 'output-available'
}

// ── v4 → v5 ───────────────────────────────────────────────────────────────────

function convertV4ToolInvocationToV5(toolInvocation: ToolInvocation): ToolUIPart {
  return {
    type: `tool-${toolInvocation.toolName}`,
    toolCallId: toolInvocation.toolCallId,
    input: toolInvocation.args,
    output: toolInvocation.state === 'result' ? toolInvocation.result : undefined,
    state: convertToolState(toolInvocation.state),
  } as ToolUIPart
}

function convertV4Part(part: unknown): UIMessage['parts'][number] {
  if (isV4ToolInvocationPart(part)) {
    return convertV4ToolInvocationToV5(part.toolInvocation)
  }
  if (isV4ReasoningPart(part)) {
    return { type: 'reasoning', text: part.reasoning }
  }
  if (isV4SourcePart(part)) {
    const src = part.source as Record<string, unknown>
    return {
      type: 'source-url',
      url: src.url as string,
      sourceId: src.id as string,
      title: src.title as string,
    }
  }
  if (isV4FilePart(part)) {
    return {
      type: 'file',
      mediaType: part.mimeType,
      url: part.data as string,
    }
  }
  // Already v5 or unknown — pass through
  return part as UIMessage['parts'][number]
}

function buildPartsFromV4TopLevel(msg: V4Message): UIMessage['parts'] {
  const parts: UIMessage['parts'] = []
  if (msg.reasoning) {
    parts.push({ type: 'reasoning', text: msg.reasoning as string })
  }
  if (msg.toolInvocations) {
    parts.push(...msg.toolInvocations.map(convertV4ToolInvocationToV5))
  }
  if (msg.content && typeof msg.content === 'string') {
    parts.push({ type: 'text', text: msg.content })
  }
  return parts
}

/**
 * Converts a stored v4-format message to the v5 UIMessage format.
 * If the message is already v5, it is returned unchanged.
 */
export function convertV4MessageToV5(msg: unknown, index: number): UIMessage {
  if (!isV4Message(msg)) {
    // Already v5 format — pass through
    return msg as UIMessage
  }

  const v4 = msg as V4Message
  const id = (v4.id as string) || `msg-${index}`
  const role = v4.role === 'data' ? 'assistant' : (v4.role as UIMessage['role'])

  if (v4.role === 'data') {
    return {
      id,
      role: 'assistant',
      parts: [{ type: 'data-custom', id: crypto.randomUUID(), data: v4.data ?? v4.content } as never],
    }
  }

  const parts = v4.parts
    ? (v4.parts as unknown[]).map(convertV4Part)
    : buildPartsFromV4TopLevel(v4)

  return { id, role, parts }
}

// ── v5 → v4 ───────────────────────────────────────────────────────────────────

function convertV5ToolPartToV4(part: ToolUIPart): ToolInvocation {
  const state: ToolInvocation['state'] =
    part.state === 'input-streaming'
      ? 'partial-call'
      : part.state === 'input-available'
        ? 'call'
        : 'result'

  const toolName = part.type.startsWith('tool-') ? part.type.slice(5) : part.type
  const base = { toolCallId: part.toolCallId, toolName, args: part.input, state }

  if (state === 'result') {
    return { ...base, state: 'result' as const, result: part.output }
  }
  return base as ToolInvocation
}

/**
 * Converts a v5 UIMessage to a v4-format message for backward-compatible storage.
 * Called when persisting messages so they can be read by either v4 or v5 readers.
 */
export function convertV5MessageToV4(msg: UIMessage): V4UIMessage {
  const parts: V4Part[] = []
  let textContent = ''
  let reasoning: string | undefined
  const toolInvocations: ToolInvocation[] = []

  for (const part of msg.parts) {
    const p = part as { type: string; [k: string]: unknown }
    if (p.type === 'text') {
      textContent = p.text as string
      parts.push({ type: 'text', text: p.text as string })
    } else if (p.type === 'reasoning') {
      reasoning = p.text as string
      parts.push({
        type: 'reasoning',
        reasoning: p.text as string,
        details: [{ type: 'text', text: p.text as string }],
      })
    } else if (p.type.startsWith('tool-')) {
      const inv = convertV5ToolPartToV4(part as ToolUIPart)
      parts.push({ type: 'tool-invocation', toolInvocation: inv })
      toolInvocations.push(inv)
    } else if (p.type === 'source-url') {
      parts.push({
        type: 'source',
        source: {
          id: p.sourceId as string | undefined,
          url: p.url as string,
          title: p.title as string | undefined,
          sourceType: 'url',
        },
      } as V4Part)
    } else if (p.type === 'file') {
      parts.push({
        type: 'file',
        mimeType: p.mediaType as string,
        data: p.url as string,
      })
    }
    // data-* parts are skipped (v5-only concept)
  }

  const result: V4UIMessage = {
    id: msg.id,
    role: msg.role as V4UIMessage['role'],
    content: textContent,
    parts,
  }
  if (reasoning) result.reasoning = reasoning
  if (toolInvocations.length > 0) result.toolInvocations = toolInvocations
  return result
}

/**
 * Converts an array of stored messages (any mix of v4/v5) to v5 UIMessage format.
 */
export function convertStoredMessages(messages: unknown[]): UIMessage[] {
  return messages.map((m, i) => convertV4MessageToV5(m, i))
}
