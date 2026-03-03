'use client';
/* eslint-disable max-len */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { listConversations, deleteConversation, deleteAllConversations, onHistoryMutation } from '@/lib/chatStorage';
import type { ConversationSummary } from '@/lib/chatStorage';
import { cn } from '@/lib/utils';

interface ConversationSidebarProps {
  open: boolean;
  currentConversationId: string;
  currentConversationHasMessages: boolean;
  unreadConversationIds?: string[];
  typingConversationIds?: string[];
  showAiConversationTitles: boolean;
  onSelectConversation: (conv: ConversationSummary) => void;
  onNewConversation: () => void;
  isStreaming: boolean;
  syncHistoryUpdates?: boolean;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return 'Just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    return `${hrs}h ago`;
  }
  const days = Math.floor(hrs / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(ts).toLocaleDateString();
}

function getFallbackConversationTitle(conv: ConversationSummary): string {
  const preview = (conv.preview ?? '').trim();
  if (preview.length > 0) {
    return preview.slice(0, 60).trim();
  }

  const typed = conv.messages as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }>; content?: unknown }>;
  const firstUser = typed.find((message) => message.role === 'user');
  if (!firstUser) {
    return 'New conversation';
  }

  const partText = firstUser.parts?.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text?.trim() ?? '';
  if (partText.length > 0) {
    return partText.slice(0, 60).trim();
  }
  if (typeof firstUser.content === 'string' && firstUser.content.trim().length > 0) {
    return firstUser.content.trim().slice(0, 60).trim();
  }
  return 'New conversation';
}

export function ConversationSidebar({
  open,
  currentConversationId,
  currentConversationHasMessages,
  unreadConversationIds = [],
  typingConversationIds = [],
  showAiConversationTitles,
  onSelectConversation,
  onNewConversation,
  isStreaming,
  syncHistoryUpdates = true,
}: ConversationSidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const unreadSet = useMemo(() => new Set(unreadConversationIds), [unreadConversationIds]);
  const typingSet = useMemo(() => new Set(typingConversationIds), [typingConversationIds]);
  const currentConversationInHistory = conversations.some((conv) => conv.id === currentConversationId);
  const transientConversation = useMemo<ConversationSummary | null>(() => {
    if (currentConversationHasMessages) {
      return null;
    }
    if (!currentConversationId || currentConversationInHistory) {
      return null;
    }
    return {
      id: currentConversationId,
      title: 'New conversation',
      preview: '',
      model: '',
      profileId: '',
      updatedAt: Date.now(),
      messages: [],
      variantsByTurn: {},
      useAutoRouting: false,
    };
  }, [currentConversationHasMessages, currentConversationId, currentConversationInHistory]);
  const displayedConversations = transientConversation ? [transientConversation, ...conversations] : conversations;

  const refresh = useCallback(async () => {
    const list = await listConversations();
    setConversations(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, currentConversationId]);

  useEffect(() => {
    if (!syncHistoryUpdates) {
      return () => {};
    }
    return onHistoryMutation(() => {
      void refresh();
    });
  }, [refresh, syncHistoryUpdates]);

  // Re-fetch when panel opens
  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteConversation(id);
    void refresh();
  }

  async function handleDeleteAll() {
    if (!confirmDeleteAll) {
      setConfirmDeleteAll(true);
      return;
    }
    await deleteAllConversations();
    setConfirmDeleteAll(false);
    void refresh();
  }

  return (
    <div
      className={cn(
        'absolute inset-y-0 left-0 z-40 flex flex-col border-r border-gray-200 bg-gray-50 transition-transform duration-200 will-change-transform dark:border-gray-800 dark:bg-gray-900',
        open ? 'translate-x-0' : '-translate-x-full pointer-events-none',
      )}
      style={{ width: '240px', minWidth: '240px', maxWidth: '240px' }}
    >
      {/* New conversation button */}
      <div className="border-b border-gray-200 p-2.5 dark:border-gray-800">
        <button
          type="button"
          onClick={(e) => {
            e.currentTarget.blur();
            onNewConversation();
          }}
          disabled={isStreaming}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <MessageSquarePlus className="h-3.5 w-3.5 flex-shrink-0" />
          New conversation
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto overscroll-y-contain">
        {displayedConversations.length === 0 ? (
          <p className="p-3 text-center text-xs text-gray-400 dark:text-gray-500">No history yet</p>
        ) : (
          <ul className="py-1">
            {displayedConversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onSelectConversation(conv);
                  }}
                  disabled={conv.id === currentConversationId}
                  className={cn(
                    'group flex w-full items-start gap-1 px-2 py-2 text-left transition-colors',
                    conv.id === currentConversationId
                      ? 'bg-blue-50 dark:bg-blue-950/40'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-800',
                    conv.id === currentConversationId && 'cursor-default',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      'sidebar-conversation-title text-xs font-medium leading-4',
                      conv.id === currentConversationId && !currentConversationHasMessages && 'italic',
                      conv.id === currentConversationId
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-gray-700 dark:text-gray-200',
                    )}>
                      {showAiConversationTitles ? conv.title : getFallbackConversationTitle(conv)}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1">
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">
                        {formatRelativeTime(conv.updatedAt)}
                      </p>
                      {unreadSet.has(conv.id) && conv.id !== currentConversationId && (
                        <span
                          aria-label="Unread updates"
                          title="Unread updates"
                          className="inline-block h-[0.5em] w-[0.5em] rounded-full bg-blue-500"
                        />
                      )}
                      {typingSet.has(conv.id) && conv.id !== currentConversationId && (
                        <span
                          aria-label="Assistant is typing"
                          title="Assistant is typing"
                          className="inline-flex items-center gap-0.5 rounded-full border border-[#7C3AED]/30 px-1 py-[1px] dark:border-[#7C3AED]/45"
                        >
                          <span className="h-[0.5em] w-[0.5em] rounded-full bg-[#7C3AED] animate-typing-bubble" />
                          <span className="h-[0.5em] w-[0.5em] rounded-full bg-[#7C3AED] animate-typing-bubble" style={{ animationDelay: '120ms' }} />
                          <span className="h-[0.5em] w-[0.5em] rounded-full bg-[#7C3AED] animate-typing-bubble" style={{ animationDelay: '240ms' }} />
                        </span>
                      )}
                    </div>
                  </div>
                  {!(conv.id === currentConversationId && !currentConversationHasMessages) && (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleDelete(conv.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          handleDelete(conv.id, e as never);
                        }
                      }}
                      title="Delete conversation"
                      className="mt-0.5 flex-shrink-0 cursor-pointer rounded p-0.5 text-gray-300 opacity-0 hover:bg-red-100 hover:text-red-500 group-hover:opacity-100 dark:text-gray-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Delete all */}
      {conversations.length > 0 && (
        <div className="border-t border-gray-200 p-2 dark:border-gray-800">
          <button
            type="button"
            onClick={handleDeleteAll}
            onBlur={() => setConfirmDeleteAll(false)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors',
              confirmDeleteAll
                ? 'bg-red-100 font-medium text-red-600 dark:bg-red-900/40 dark:text-red-400'
                : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300',
            )}
          >
            <Trash2 className="h-3 w-3 flex-shrink-0" />
            {confirmDeleteAll ? 'Confirm delete all' : 'Delete all history'}
          </button>
        </div>
      )}
    </div>
  );
}
