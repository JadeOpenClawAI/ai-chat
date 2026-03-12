import { createHash } from 'crypto';
import type { AppConfig, MastraMemoryHistoryScope } from '@/lib/config/store';

export const SHARED_CHAT_THREAD_ID = 'chat:shared';
export const SHARED_COMPAT_THREAD_ID = 'compat:shared';

let cachedAuthenticatedResourceId: string | null = null;

export function resolveAuthenticatedResourceId(): string {
  if (cachedAuthenticatedResourceId) {
    return cachedAuthenticatedResourceId;
  }

  const seed = (
    process.env.AUTH_SECRET?.trim()
    || process.env.AUTH_PASSWORD?.trim()
    || 'ai-chat:single-user'
  );
  const suffix = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  cachedAuthenticatedResourceId = `authenticated:${suffix}`;
  return cachedAuthenticatedResourceId;
}

export function getMastraMessageHistoryScope(config: Pick<AppConfig, 'mastraMemory'>): MastraMemoryHistoryScope {
  return config.mastraMemory?.messageHistoryScope === 'per-conversation'
    ? 'per-conversation'
    : 'all-conversations';
}

export function resolveChatThreadId(
  config: Pick<AppConfig, 'mastraMemory'>,
  conversationId: string | undefined,
): string {
  if (getMastraMessageHistoryScope(config) === 'all-conversations') {
    return SHARED_CHAT_THREAD_ID;
  }

  const normalizedConversationId = conversationId?.trim();
  if (!normalizedConversationId) {
    throw new Error('conversationId is required when Mastra message history scope is per-conversation');
  }

  return `conversation:${normalizedConversationId}`;
}

export function resolveCompatThreadId(
  config: Pick<AppConfig, 'mastraMemory'>,
  headerThreadId: string | null,
): string {
  if (getMastraMessageHistoryScope(config) === 'all-conversations') {
    return SHARED_COMPAT_THREAD_ID;
  }

  const normalizedHeaderThreadId = headerThreadId?.trim();
  return normalizedHeaderThreadId || SHARED_COMPAT_THREAD_ID;
}
