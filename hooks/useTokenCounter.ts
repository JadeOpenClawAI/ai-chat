// ============================================================
// useTokenCounter — real-time token count estimation
// ============================================================

'use client'

import { useMemo } from 'react'
import type { Message } from 'ai'

/** Estimates token count for a string (client-side, no WASM needed). */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function useTokenCounter(messages: Message[], limit: number) {
  const used = useMemo(() => {
    let total = 0
    for (const msg of messages) {
      total += 4 // overhead per message
      total += estimateTokens(msg.content)
    }
    return total
  }, [messages])

  const percentage = limit > 0 ? used / limit : 0
  const remaining = Math.max(0, limit - used)

  return { used, limit, percentage, remaining }
}
