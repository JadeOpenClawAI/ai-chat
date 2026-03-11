import type { AppConfig } from '@/lib/config/store';

export const MASTRA_MEMORY_RESOURCE_ID = 'default';
export const SHARED_CHAT_THREAD_ID = 'chat:shared';
export const SHARED_COMPAT_THREAD_ID = 'compat:shared';

export type MastraMemoryScope = 'all-conversations' | 'per-conversation';

export function getMastraMemoryScope(config: Pick<AppConfig, 'uiSettings'>): MastraMemoryScope {
  return config.uiSettings?.mastraMemoryScope === 'per-conversation'
    ? 'per-conversation'
    : 'all-conversations';
}

export function resolveChatThreadId(
  config: Pick<AppConfig, 'uiSettings'>,
  conversationId: string | undefined,
): string {
  if (getMastraMemoryScope(config) === 'all-conversations') {
    return SHARED_CHAT_THREAD_ID;
  }

  const normalizedConversationId = conversationId?.trim();
  if (!normalizedConversationId) {
    throw new Error('conversationId is required when Mastra memory scope is per-conversation');
  }

  return `conversation:${normalizedConversationId}`;
}

export function resolveCompatThreadId(
  config: Pick<AppConfig, 'uiSettings'>,
  headerThreadId: string | null,
): string {
  if (getMastraMemoryScope(config) === 'all-conversations') {
    return SHARED_CHAT_THREAD_ID;
  }

  const normalizedHeaderThreadId = headerThreadId?.trim();
  return normalizedHeaderThreadId || SHARED_COMPAT_THREAD_ID;
}
