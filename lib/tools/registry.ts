// ============================================================
// Tool Registry with State Tracking
// Manages tool definitions, execution state, and UI subscriptions
// ============================================================

import type { ToolState, ToolCallMeta, ToolDefinition } from '@/lib/types'

// ── EventEmitter-style subscription ─────────────────────────

type Listener = (meta: ToolCallMeta) => void

// ── ToolRegistry class ───────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private callState = new Map<string, ToolCallMeta>()
  private listeners = new Set<Listener>()

  // ── Registration ─────────────────────────────────────────

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool)
    return this
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  // ── State tracking ────────────────────────────────────────

  startCall(toolCallId: string, toolName: string): ToolCallMeta {
    const def = this.tools.get(toolName)
    const meta: ToolCallMeta = {
      toolCallId,
      toolName,
      state: 'running',
      icon: def?.icon,
      startedAt: Date.now(),
    }
    this.callState.set(toolCallId, meta)
    this.emit(meta)
    return meta
  }

  updateState(
    toolCallId: string,
    state: ToolState,
    extra?: Partial<ToolCallMeta>,
  ): ToolCallMeta | undefined {
    const meta = this.callState.get(toolCallId)
    if (!meta) return undefined

    const updated: ToolCallMeta = {
      ...meta,
      state,
      ...extra,
      ...(state === 'done' || state === 'error'
        ? { finishedAt: Date.now() }
        : {}),
    }
    this.callState.set(toolCallId, updated)
    this.emit(updated)
    return updated
  }

  getState(toolCallId: string): ToolCallMeta | undefined {
    return this.callState.get(toolCallId)
  }

  clearCall(toolCallId: string): void {
    this.callState.delete(toolCallId)
  }

  clearAll(): void {
    this.callState.clear()
  }

  // ── Subscriptions ─────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(meta: ToolCallMeta): void {
    for (const listener of this.listeners) {
      try {
        listener(meta)
      } catch (err) {
        console.error('[ToolRegistry] Listener error:', err)
      }
    }
  }
}

// ── Singleton registry for server-side use ───────────────────
// Note: In production serverless, this resets per-invocation.
// For persistent tracking, use a Redis-backed store.
export const globalRegistry = new ToolRegistry()
