'use client';
/* eslint-disable max-len */

import { useEffect, useState, useCallback } from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { listConversations, deleteConversation, deleteAllConversations } from '@/lib/chatStorage';
import type { ConversationSummary } from '@/lib/chatStorage';
import { cn } from '@/lib/utils';

interface ConversationSidebarProps {
  open: boolean;
  currentConversationId: string;
  onSelectConversation: (conv: ConversationSummary) => void;
  onNewConversation: () => void;
  isStreaming: boolean;
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

export function ConversationSidebar({
  open,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  isStreaming,
}: ConversationSidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const refresh = useCallback(async () => {
    const list = await listConversations();
    setConversations(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, currentConversationId]);

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
        'absolute inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-gray-200 bg-gray-50 transition-transform duration-200 dark:border-gray-800 dark:bg-gray-900',
        open ? 'translate-x-0' : '-translate-x-full pointer-events-none',
      )}
    >
      {/* New conversation button */}
      <div className="border-b border-gray-200 p-2.5 dark:border-gray-800">
        <button
          type="button"
          onClick={onNewConversation}
          disabled={isStreaming}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <MessageSquarePlus className="h-3.5 w-3.5 flex-shrink-0" />
          New conversation
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto overscroll-y-contain">
        {conversations.length === 0 ? (
          <p className="p-3 text-center text-xs text-gray-400 dark:text-gray-500">No history yet</p>
        ) : (
          <ul className="py-1">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  onClick={() => !isStreaming && onSelectConversation(conv)}
                  disabled={isStreaming || conv.id === currentConversationId}
                  className={cn(
                    'group flex w-full items-start gap-1 px-2 py-2 text-left transition-colors',
                    conv.id === currentConversationId
                      ? 'bg-blue-50 dark:bg-blue-950/40'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-800',
                    isStreaming && 'cursor-default opacity-60',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      'truncate text-xs font-medium',
                      conv.id === currentConversationId
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-gray-700 dark:text-gray-200',
                    )}>
                      {conv.title}
                    </p>
                    <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
                      {formatRelativeTime(conv.updatedAt)}
                    </p>
                  </div>
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
