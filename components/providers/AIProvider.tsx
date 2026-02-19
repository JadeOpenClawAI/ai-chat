// ============================================================
// AI Provider — wraps the app with assistant-ui context
// ============================================================

'use client'

import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useVercelUseChatRuntime } from '@assistant-ui/react-ai-sdk'
import type { ReactNode } from 'react'

interface AIProviderProps {
  children: ReactNode
}

/**
 * Thin wrapper that sets up @assistant-ui/react runtime.
 * The actual chat hook is managed per-component, but this
 * provides the runtime context for assistant-ui primitives.
 */
export function AIProvider({ children }: AIProviderProps) {
  return <>{children}</>
}

// Export a hook-based runtime provider for use with assistant-ui Thread components
export function AssistantProvider({
  children,
  chatHook,
}: {
  children: ReactNode
  chatHook: Parameters<typeof useVercelUseChatRuntime>[0]
}) {
  const runtime = useVercelUseChatRuntime(chatHook)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  )
}
