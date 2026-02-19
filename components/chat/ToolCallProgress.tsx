// ============================================================
// Tool Call Progress UI
// Rich visual feedback for tool execution states
// ============================================================

'use client'

import { useState } from 'react'
import type { ToolCallMeta } from '@/lib/types'
import {
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Zap,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToolCallProgressProps {
  toolCall: ToolCallMeta
  result?: string
}

export function ToolCallProgress({ toolCall, result }: ToolCallProgressProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { state, toolName, icon, error, resultSummarized } = toolCall

  const elapsedMs =
    toolCall.startedAt && toolCall.finishedAt
      ? toolCall.finishedAt - toolCall.startedAt
      : undefined

  return (
    <div
      className={cn(
        'my-2 rounded-lg border text-sm transition-all',
        state === 'done' && 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950',
        state === 'error' && 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950',
        (state === 'running' || state === 'streaming' || state === 'pending') &&
          'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950',
        state === 'summarizing' &&
          'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950',
      )}
    >
      {/* Header */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2"
        onClick={() => state === 'done' && setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (state === 'done') setIsExpanded((v) => !v)
          }
        }}
      >
        {/* Status icon */}
        <StatusIcon state={state} />

        {/* Tool emoji + name */}
        <span className="font-medium">
          {icon} {formatToolName(toolName)}
        </span>

        {/* State label */}
        <span
          className={cn(
            'ml-1 text-xs',
            state === 'done' && 'text-green-600 dark:text-green-400',
            state === 'error' && 'text-red-600 dark:text-red-400',
            state === 'running' && 'text-blue-600 dark:text-blue-400',
            state === 'pending' && 'text-blue-500 dark:text-blue-400',
            state === 'summarizing' && 'text-yellow-600 dark:text-yellow-400',
          )}
        >
          {getStateLabel(state)}
        </span>

        {/* Timing */}
        {elapsedMs !== undefined && (
          <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
            <Clock className="h-3 w-3" />
            {formatMs(elapsedMs)}
          </span>
        )}

        {/* Summarized badge */}
        {resultSummarized && (
          <span className="ml-1 flex items-center gap-1 rounded bg-yellow-200 px-1.5 py-0.5 text-xs text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200">
            <Zap className="h-3 w-3" />
            Summarized
          </span>
        )}

        {/* Expand toggle for done state */}
        {state === 'done' && result && (
          <span className="ml-1 text-gray-400">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>
        )}
      </div>

      {/* Error message */}
      {state === 'error' && error && (
        <div className="border-t border-red-200 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Expandable result */}
      {state === 'done' && isExpanded && result && (
        <div className="border-t border-green-200 dark:border-green-800">
          <pre className="max-h-64 overflow-auto px-3 py-2 text-xs text-gray-700 dark:text-gray-300">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────

function StatusIcon({ state }: { state: ToolCallMeta['state'] }) {
  switch (state) {
    case 'pending':
      return (
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
      )
    case 'running':
    case 'streaming':
      return (
        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
      )
    case 'summarizing':
      return (
        <Loader2 className="h-4 w-4 animate-spin text-yellow-600" />
      )
    case 'done':
      return (
        <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
      )
    case 'error':
      return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
    default:
      return null
  }
}

// ── Helpers ───────────────────────────────────────────────────

function formatToolName(name: string): string {
  // camelCase → Title Case
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

function getStateLabel(state: ToolCallMeta['state']): string {
  switch (state) {
    case 'pending':
      return 'Preparing...'
    case 'running':
      return 'Running...'
    case 'streaming':
      return 'Streaming...'
    case 'summarizing':
      return 'Compacting large result...'
    case 'done':
      return 'Done'
    case 'error':
      return 'Failed'
    default:
      return state
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
