'use client';
/* eslint-disable max-len */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { useChat } from '@/hooks/useChat';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SubAgentPanel } from './SubAgentPanel';
import { FaviconStatus } from './FaviconStatus';
import { MODEL_OPTIONS } from '@/lib/types';
import { formatTokens, cn } from '@/lib/utils';
import { ChevronDown, Zap, Info, Settings, X, Sun, Moon, Monitor, LogOut, MessageSquarePlus, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { ConversationSidebar } from './ConversationSidebar';
import { broadcastStateUpdate } from '@/lib/chatStorage';
import { saveConversationToHistory, type ConversationSummary } from '@/lib/chatStorage';

interface ToolCatalogItem {
  name: string;
  description: string;
  icon: string;
  expectedDurationMs: number;
  inputs: string[];
  outputs: string[];
  inputSchema?: unknown;
}

type ThemePref = 'light' | 'dark' | 'system';
const SIDEBAR_OPEN_STORAGE_KEY = 'ai-chat:sidebar-open';
const SIDEBAR_OPEN_SESSION_KEY = 'ai-chat:sidebar-open:session';
const UNREAD_CONVERSATIONS_STORAGE_KEY = 'ai-chat:unread-conversations';
const STREAMING_CONVERSATIONS_STORAGE_KEY = 'ai-chat:streaming-conversations';
const STREAMING_TAB_ID_SESSION_KEY = 'ai-chat:streaming-tab-id';
const SIDEBAR_WIDTH_REM = 15;
let inMemorySidebarOpen: boolean | null = null;
const DEBUG_SIDEBAR = process.env.NODE_ENV !== 'production';

type StreamingConversationsByTab = Record<string, string[]>;

function normalizeUnreadConversationIds(ids: string[]): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return [...unique];
}

function parseUnreadConversationIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = parsed.filter((entry): entry is string => typeof entry === 'string');
    return normalizeUnreadConversationIds(ids);
  } catch {
    return [];
  }
}

function normalizeStreamingConversationsByTab(entries: StreamingConversationsByTab): StreamingConversationsByTab {
  const normalized: StreamingConversationsByTab = {};
  for (const [conversationId, tabIds] of Object.entries(entries)) {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || !Array.isArray(tabIds)) {
      continue;
    }
    const uniqueTabIds = new Set<string>();
    for (const tabId of tabIds) {
      if (typeof tabId !== 'string') {
        continue;
      }
      const normalizedTabId = tabId.trim();
      if (normalizedTabId) {
        uniqueTabIds.add(normalizedTabId);
      }
    }
    if (uniqueTabIds.size > 0) {
      normalized[normalizedConversationId] = [...uniqueTabIds];
    }
  }
  return normalized;
}

function parseStreamingConversationsByTab(raw: string | null): StreamingConversationsByTab {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const maybeEntries = parsed as Record<string, unknown>;
    const entries: StreamingConversationsByTab = {};
    for (const [conversationId, tabIds] of Object.entries(maybeEntries)) {
      if (!Array.isArray(tabIds)) {
        continue;
      }
      entries[conversationId] = tabIds.filter((entry): entry is string => typeof entry === 'string');
    }
    return normalizeStreamingConversationsByTab(entries);
  } catch {
    return {};
  }
}

function removeTabFromStreamingConversations(entries: StreamingConversationsByTab, tabId: string): StreamingConversationsByTab {
  const normalizedTabId = tabId.trim();
  if (!normalizedTabId) {
    return entries;
  }
  const next: StreamingConversationsByTab = {};
  for (const [conversationId, tabIds] of Object.entries(entries)) {
    const filteredTabIds = tabIds.filter((existingTabId) => existingTabId !== normalizedTabId);
    if (filteredTabIds.length > 0) {
      next[conversationId] = filteredTabIds;
    }
  }
  return next;
}

function mergeAssistantMessage(messages: UIMessage[], nextAssistant: UIMessage): UIMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === nextAssistant.id);
  if (existingIndex >= 0) {
    const nextMessages = [...messages];
    nextMessages[existingIndex] = nextAssistant;
    return nextMessages;
  }
  return [...messages, nextAssistant];
}

function toUIMessageChunkStream(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeEvents = (controller: ReadableStreamDefaultController<UIMessageChunk>, flushRemainder: boolean) => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    let start = 0;
    while (true) {
      const boundaryIndex = normalized.indexOf('\n\n', start);
      if (boundaryIndex === -1) {
        break;
      }
      const eventBlock = normalized.slice(start, boundaryIndex);
      start = boundaryIndex + 2;
      const payload = eventBlock
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      try {
        controller.enqueue(JSON.parse(payload) as UIMessageChunk);
      } catch {
        // Ignore malformed chunks.
      }
    }

    buffer = normalized.slice(start);
    if (flushRemainder) {
      const payload = buffer
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (payload && payload !== '[DONE]') {
        try {
          controller.enqueue(JSON.parse(payload) as UIMessageChunk);
        } catch {
          // Ignore malformed chunks.
        }
      }
      buffer = '';
    }
  };

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              buffer += decoder.decode(value, { stream: true });
              consumeEvents(controller, false);
            }
          }
          buffer += decoder.decode();
          consumeEvents(controller, true);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      };
      void pump();
    },
    cancel() {
      return reader.cancel();
    },
  });
}

function readStoredSidebarOpen(): boolean {
  if (inMemorySidebarOpen !== null) {
    return inMemorySidebarOpen;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const session = window.sessionStorage.getItem(SIDEBAR_OPEN_SESSION_KEY);
    if (session === '1' || session === '0') {
      const parsed = session === '1';
      inMemorySidebarOpen = parsed;
      return parsed;
    }
  } catch {
    // Session storage is optional.
  }
  try {
    const synced = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (synced === '1' || synced === '0') {
      const parsed = synced === '1';
      inMemorySidebarOpen = parsed;
      return parsed;
    }
  } catch {
    // Local storage is optional.
  }
  inMemorySidebarOpen = false;
  return false;
}

function writeSessionSidebarOpen(next: boolean): void {
  inMemorySidebarOpen = next;
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(SIDEBAR_OPEN_SESSION_KEY, next ? '1' : '0');
  } catch {
    // Session storage is optional.
  }
}

interface ToolParamRow {
  key: string;
  depth: number;
  type: string;
  required: boolean;
  description?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set<string>();
  }
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

function readType(node: Record<string, unknown>): string {
  const type = node.type;
  return typeof type === 'string' ? type : 'string';
}

function readDescription(node: Record<string, unknown>): string | undefined {
  return typeof node.description === 'string' ? node.description : undefined;
}

function readEnumNote(node: Record<string, unknown>): string | undefined {
  const values = node.enum;
  if (!Array.isArray(values)) {
    return undefined;
  }
  const strings = values.filter((entry): entry is string => typeof entry === 'string');
  return strings.length ? `enum: ${strings.join(' | ')}` : undefined;
}

function readAdditionalPropertyType(value: unknown): string | null {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (value === true) {
    return 'unknown';
  }
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  return typeof type === 'string' ? type : 'unknown';
}

function collectObjectPropertiesRows(
  properties: Record<string, unknown>,
  parentPath: string,
  requiredSet: Set<string>,
  depth: number,
  rows: ToolParamRow[],
) {
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) {
      continue;
    }
    const path = parentPath ? `${parentPath}.${name}` : name;
    collectParameterNodeRows(raw, path, requiredSet.has(name), depth, rows);
  }
}

function collectParameterNodeRows(
  node: Record<string, unknown>,
  path: string,
  required: boolean,
  depth: number,
  rows: ToolParamRow[],
) {
  const type = readType(node);
  const enumNote = readEnumNote(node);
  rows.push({
    key: path,
    depth,
    type,
    required,
    description: readDescription(node),
    note: enumNote,
  });

  if (type === 'object') {
    const properties = isRecord(node.properties) ? node.properties : null;
    if (properties) {
      collectObjectPropertiesRows(properties, path, toStringSet(node.required), depth + 1, rows);
    }
    const additionalType = readAdditionalPropertyType(node.additionalProperties);
    if (additionalType) {
      rows.push({
        key: `${path}.*`,
        depth: depth + 1,
        type: additionalType,
        required: false,
        note: 'additional properties',
      });
    }
  }

  if (type === 'array') {
    const items = isRecord(node.items) ? node.items : null;
    if (!items) {
      return;
    }
    rows.push({
      key: `${path}[]`,
      depth: depth + 1,
      type: readType(items),
      required: false,
      note: 'array items',
    });
    if (readType(items) === 'object') {
      const itemProperties = isRecord(items.properties) ? items.properties : null;
      if (itemProperties) {
        collectObjectPropertiesRows(itemProperties, `${path}[]`, toStringSet(items.required), depth + 2, rows);
      }
      const additionalType = readAdditionalPropertyType(items.additionalProperties);
      if (additionalType) {
        rows.push({
          key: `${path}[].*`,
          depth: depth + 2,
          type: additionalType,
          required: false,
          note: 'additional properties',
        });
      }
    }
  }
}

function getToolParameterRows(schema: unknown): ToolParamRow[] {
  if (!isRecord(schema)) {
    return [];
  }

  if (schema.type === 'object' && isRecord(schema.properties)) {
    const rows: ToolParamRow[] = [];
    collectObjectPropertiesRows(schema.properties, '', toStringSet(schema.required), 0, rows);
    return rows;
  }

  const rows: ToolParamRow[] = [];
  for (const [name, raw] of Object.entries(schema)) {
    if (!isRecord(raw)) {
      continue;
    }
    collectParameterNodeRows(raw, name, raw.required === true, 0, rows);
  }
  return rows;
}

function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      setLoading(false);
    }
  }

  // Only render if AUTH_PASSWORD is configured (server sets this via env)
  // We detect this by attempting the logout; always render for simplicity
  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      title="Sign out"
      className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-300"
    >
      <LogOut className="h-4 w-4" />
    </button>
  );
}

export function ChatInterface() {
  const {
    messages,
    input,
    setInput,
    setInputValue,
    isLoading,
    remoteIsStreaming,
    stop,
    sendMessage,
    clearConversation,
    syncConversationSelection,
    loadConversation,
    conversationId,
    profileId,
    setProfileId,
    profiles,
    availableModelsForProfile,
    model,
    setModel,
    isAutoRouting,
    setIsAutoRouting,
    crossTabSync,
    aiConversationTitlesEnabled,
    routeToast,
    routeToastKey,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    contextStats,
    contextPolicy,
    wasCompacted,
    compactionMode,
    toolCallStates,
    subAgentRuns,
    assistantVariantMeta,
    hiddenAssistantMessageIds,
    switchAssistantVariant,
    regenerateAssistantAt,
  } = useChat();

  const handleSend = useCallback(async () => {
    const val =
      typeof input === 'string'
        ? input
        : (input as unknown as { target: { value: string } })?.target?.value ?? '';
    if (!val.trim() && pendingAttachments.length === 0) {
      return;
    }
    setInputValue('');
    await sendMessage(val);
  }, [input, pendingAttachments, sendMessage, setInputValue]);

  const availableModels = (() => {
    if (availableModelsForProfile.length === 0) {
      return MODEL_OPTIONS;
    }
    const activeProvider = profiles.find((p) => p.id === profileId)?.provider;
    const seenIds = new Set<string>();
    // For each allowed model ID, pick the MODEL_OPTIONS entry whose provider
    // matches the active profile — fall back to the first match if none does.
    const known = availableModelsForProfile.flatMap((id) => {
      if (seenIds.has(id)) {
        return [];
      }
      const matches = MODEL_OPTIONS.filter((m) => m.id === id);
      if (matches.length === 0) {
        return [];
      }
      seenIds.add(id);
      const preferred = matches.find((m) => m.provider === activeProvider) ?? matches[0];
      return [preferred];
    });
    const custom = availableModelsForProfile
      .filter((id) => !seenIds.has(id))
      .map((id) => {
        seenIds.add(id);
        return {
          id,
          name: id,
          provider: 'custom' as const,
          contextWindow: 200000,
          supportsVision: false,
          supportsTools: true,
        };
      });
    return [...known, ...custom];
  })();

  const [mounted, setMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detachedConversation, setDetachedConversation] = useState<ConversationSummary | null>(null);
  const [detachedConversationInput, setDetachedConversationInput] = useState('');
  const [backgroundConversations, setBackgroundConversations] = useState<Record<string, ConversationSummary>>({});
  const [backgroundStreamingConversationIds, setBackgroundStreamingConversationIds] = useState<string[]>([]);
  const [unreadConversationIds, setUnreadConversationIds] = useState<string[]>([]);
  const [streamingConversationsByTab, setStreamingConversationsByTab] = useState<StreamingConversationsByTab>({});
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsCatalog, setToolsCatalog] = useState<ToolCatalogItem[]>([]);
  const [themePref, setThemePref] = useState<ThemePref>('system');
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const viewportResizeRaf = useRef<number | null>(null);
  const backgroundStreamControllersRef = useRef<Record<string, AbortController>>({});
  const backgroundPersistAtRef = useRef<Record<string, number>>({});
  const backgroundBroadcastAtRef = useRef<Record<string, number>>({});
  const backgroundStreamingIdsRef = useRef<string[]>([]);
  const activeStreamingConversationIdRef = useRef('');
  const streamingTabIdRef = useRef('');
  const isLoadingRef = useRef(isLoading);
  const sidebarMutationReasonRef = useRef('init');
  const shouldSyncSidebarOpen = (crossTabSync?.enabled ?? true) && (crossTabSync?.syncSidebarOpen ?? true);
  const shouldSyncSubAgentPanel = (crossTabSync?.enabled ?? true) && (crossTabSync?.syncSubAgentPanel ?? true);
  const shouldSyncHistory = (crossTabSync?.enabled ?? true) && (crossTabSync?.syncHistory ?? true);
  const shouldBroadcastDetachedChatState = (crossTabSync?.enabled ?? true)
    && (
      (crossTabSync?.syncMessages ?? true)
      || (crossTabSync?.syncConversationSelection ?? true)
      || (crossTabSync?.syncStreamingState ?? true)
    );
  const setUnreadConversationIdsSynced = useCallback((
    updater: string[] | ((prev: string[]) => string[]),
  ) => {
    setUnreadConversationIds((prev) => {
      const nextRaw = typeof updater === 'function'
        ? updater(prev)
        : updater;
      const next = normalizeUnreadConversationIds(nextRaw);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(UNREAD_CONVERSATIONS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);
  const setStreamingConversationsByTabSynced = useCallback((
    updater: StreamingConversationsByTab | ((prev: StreamingConversationsByTab) => StreamingConversationsByTab),
  ) => {
    setStreamingConversationsByTab((prev) => {
      const latestFromStorage = typeof window !== 'undefined'
        ? parseStreamingConversationsByTab(window.localStorage.getItem(STREAMING_CONVERSATIONS_STORAGE_KEY))
        : prev;
      const nextRaw = typeof updater === 'function'
        ? updater(latestFromStorage)
        : updater;
      const next = normalizeStreamingConversationsByTab(nextRaw);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STREAMING_CONVERSATIONS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);
  const setConversationStreamingPresence = useCallback((conversationIdToUpdate: string, isStreaming: boolean) => {
    const conversationKey = conversationIdToUpdate.trim();
    const tabId = streamingTabIdRef.current.trim();
    if (!conversationKey || !tabId) {
      return;
    }
    setStreamingConversationsByTabSynced((prev) => {
      const next: StreamingConversationsByTab = { ...prev };
      const existingTabIds = new Set(next[conversationKey] ?? []);
      if (isStreaming) {
        existingTabIds.add(tabId);
      } else {
        existingTabIds.delete(tabId);
      }
      if (existingTabIds.size > 0) {
        next[conversationKey] = [...existingTabIds];
      } else {
        delete next[conversationKey];
      }
      return next;
    });
  }, [setStreamingConversationsByTabSynced]);

  useEffect(() => {
    setMounted(true);
    // Restore persisted open state after hydration so SSR/CSR markup stays deterministic.
    setSidebarOpen(readStoredSidebarOpen());
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setUnreadConversationIds(
      parseUnreadConversationIds(window.localStorage.getItem(UNREAD_CONVERSATIONS_STORAGE_KEY)),
    );

    const onStorage = (event: StorageEvent) => {
      if (event.key !== UNREAD_CONVERSATIONS_STORAGE_KEY) {
        return;
      }
      setUnreadConversationIds(parseUnreadConversationIds(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let tabId: string;
    try {
      const storedTabId = window.sessionStorage.getItem(STREAMING_TAB_ID_SESSION_KEY);
      if (storedTabId && storedTabId.trim()) {
        tabId = storedTabId.trim();
      } else {
        tabId = crypto.randomUUID();
        window.sessionStorage.setItem(STREAMING_TAB_ID_SESSION_KEY, tabId);
      }
    } catch {
      tabId = crypto.randomUUID();
    }
    streamingTabIdRef.current = tabId;
    setStreamingConversationsByTab(
      parseStreamingConversationsByTab(window.localStorage.getItem(STREAMING_CONVERSATIONS_STORAGE_KEY)),
    );

    const clearTabStreamingPresence = () => {
      const activeTabId = streamingTabIdRef.current.trim();
      if (!activeTabId) {
        return;
      }
      const latest = parseStreamingConversationsByTab(
        window.localStorage.getItem(STREAMING_CONVERSATIONS_STORAGE_KEY),
      );
      const next = removeTabFromStreamingConversations(latest, activeTabId);
      window.localStorage.setItem(STREAMING_CONVERSATIONS_STORAGE_KEY, JSON.stringify(next));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== STREAMING_CONVERSATIONS_STORAGE_KEY) {
        return;
      }
      setStreamingConversationsByTab(parseStreamingConversationsByTab(event.newValue));
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', clearTabStreamingPresence);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', clearTabStreamingPresence);
      clearTabStreamingPresence();
    };
  }, []);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);
  useEffect(() => {
    const previous = new Set(backgroundStreamingIdsRef.current);
    const next = new Set(backgroundStreamingConversationIds);
    for (const conversationKey of next) {
      if (!previous.has(conversationKey)) {
        setConversationStreamingPresence(conversationKey, true);
      }
    }
    for (const conversationKey of previous) {
      if (!next.has(conversationKey)) {
        setConversationStreamingPresence(conversationKey, false);
      }
    }
    backgroundStreamingIdsRef.current = backgroundStreamingConversationIds;
  }, [backgroundStreamingConversationIds, setConversationStreamingPresence]);
  useEffect(() => {
    const next = isLoading ? conversationId : '';
    const previous = activeStreamingConversationIdRef.current;
    if (previous === next) {
      return;
    }
    if (previous) {
      setConversationStreamingPresence(previous, false);
    }
    if (next) {
      setConversationStreamingPresence(next, true);
    }
    activeStreamingConversationIdRef.current = next;
  }, [conversationId, isLoading, setConversationStreamingPresence]);
  useEffect(() => {
    // If a remount/reset path closes the sidebar while streaming, keep the
    // user's last explicit open state until they intentionally close it.
    if (isLoading && !sidebarOpen && inMemorySidebarOpen === true) {
      if (DEBUG_SIDEBAR) {
        console.debug('[sidebar] reopen guard', {
          isLoading,
          sidebarOpen,
          inMemorySidebarOpen,
        });
      }
      setSidebarOpen(true);
    }
  }, [isLoading, sidebarOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!shouldSyncSidebarOpen) {
      return;
    }

    const applyIncomingOpenState = (nextOpen: boolean) => {
      setSidebarOpen((prev) => {
        if (prev === nextOpen) {
          return prev;
        }
        if (DEBUG_SIDEBAR) {
          console.debug('[sidebar] incoming sync', {
            prev,
            next: nextOpen,
            isLoading: isLoadingRef.current,
          });
        }
        // Keep the sidebar open while streaming unless this tab explicitly closes it.
        if (isLoadingRef.current && prev && !nextOpen) {
          return prev;
        }
        writeSessionSidebarOpen(nextOpen);
        return nextOpen;
      });
    };

    const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (stored === '1' || stored === '0') {
      applyIncomingOpenState(stored === '1');
    }
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== SIDEBAR_OPEN_STORAGE_KEY || !ev.newValue) {
        return;
      }
      if (ev.newValue === '1' || ev.newValue === '0') {
        applyIncomingOpenState(ev.newValue === '1');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [shouldSyncSidebarOpen]);

  const setSidebarOpenSynced = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setSidebarOpen((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (DEBUG_SIDEBAR && prev !== resolved) {
        console.debug('[sidebar] state', {
          prev,
          next: resolved,
          reason: sidebarMutationReasonRef.current,
          isLoading: isLoadingRef.current,
        });
      }
      writeSessionSidebarOpen(resolved);
      if (shouldSyncSidebarOpen && typeof window !== 'undefined') {
        window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, resolved ? '1' : '0');
      }
      return resolved;
    });
  }, [shouldSyncSidebarOpen]);
  const closeSidebar = useCallback((reason: string) => {
    sidebarMutationReasonRef.current = reason;
    setSidebarOpenSynced(false);
  }, [setSidebarOpenSynced]);
  const blurActiveElement = useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  }, []);
  const toggleSidebar = useCallback((isOpen: boolean) => {
    sidebarMutationReasonRef.current = 'toggle-button';
    setSidebarOpenSynced(!isOpen);
  }, [setSidebarOpenSynced]);
  const upsertBackgroundConversation = useCallback((nextConversation: ConversationSummary) => {
    setBackgroundConversations((prev) => ({ ...prev, [nextConversation.id]: nextConversation }));
    setDetachedConversation((prev) => {
      if (!prev || prev.id !== nextConversation.id) {
        return prev;
      }
      return nextConversation;
    });
  }, []);
  const setConversationStreaming = useCallback((conversationKey: string, isStreaming: boolean) => {
    setBackgroundStreamingConversationIds((prev) => {
      const exists = prev.includes(conversationKey);
      if (isStreaming) {
        return exists ? prev : [...prev, conversationKey];
      }
      return exists ? prev.filter((id) => id !== conversationKey) : prev;
    });
  }, []);
  const persistDetachedConversation = useCallback((conversation: ConversationSummary, force = false) => {
    const now = Date.now();
    if (!force) {
      const lastPersistedAt = backgroundPersistAtRef.current[conversation.id] ?? 0;
      if (now - lastPersistedAt < 450) {
        return;
      }
    }
    backgroundPersistAtRef.current[conversation.id] = now;
    void saveConversationToHistory({
      conversationId: conversation.id,
      messages: conversation.messages,
      profileId: conversation.profileId || profileId,
      model: conversation.model || model,
      useAutoRouting: typeof conversation.useAutoRouting === 'boolean' ? conversation.useAutoRouting : isAutoRouting,
      routeToast: '',
      routeToastKey: 0,
      variantsByTurn: conversation.variantsByTurn ?? {},
      conversationTitle: conversation.aiTitle,
      conversationTitleVersion: conversation.aiTitleVersion,
      updatedAt: now,
      isStreaming: false,
      selectionUpdatedAt: now,
    });
  }, [isAutoRouting, model, profileId]);
  const broadcastDetachedConversationState = useCallback((
    conversation: ConversationSummary,
    isStreaming: boolean,
    force = false,
  ) => {
    if (!shouldBroadcastDetachedChatState) {
      return;
    }
    const now = Date.now();
    if (!force) {
      const lastBroadcastAt = backgroundBroadcastAtRef.current[conversation.id] ?? 0;
      if (now - lastBroadcastAt < 120) {
        return;
      }
    }
    const lastBroadcastAt = backgroundBroadcastAtRef.current[conversation.id] ?? 0;
    const updatedAt = now > lastBroadcastAt ? now : lastBroadcastAt + 1;
    backgroundBroadcastAtRef.current[conversation.id] = updatedAt;
    broadcastStateUpdate({
      conversationId: conversation.id,
      // Keep detached stream updates from forcing follower tabs to jump threads.
      selectionUpdatedAt: 0,
      messages: conversation.messages,
      profileId: conversation.profileId || profileId,
      model: conversation.model || model,
      useAutoRouting: typeof conversation.useAutoRouting === 'boolean' ? conversation.useAutoRouting : isAutoRouting,
      routeToast: '',
      routeToastKey: 0,
      variantsByTurn: conversation.variantsByTurn ?? {},
      conversationTitle: conversation.aiTitle,
      conversationTitleVersion: conversation.aiTitleVersion,
      updatedAt,
      isStreaming,
    });
  }, [isAutoRouting, model, profileId, shouldBroadcastDetachedChatState]);
  const markConversationUnread = useCallback((conversationKey: string) => {
    setUnreadConversationIdsSynced((prev) => (prev.includes(conversationKey) ? prev : [...prev, conversationKey]));
  }, [setUnreadConversationIdsSynced]);
  const startDetachedConversationStream = useCallback(async (
    baseConversation: ConversationSummary,
    userParts: Array<{ type: string; text?: string; url?: string; mediaType?: string }>,
    userMessageId?: string,
  ) => {
    if (!baseConversation.id || backgroundStreamControllersRef.current[baseConversation.id]) {
      return;
    }

    const userMessage: UIMessage = {
      id: userMessageId ?? crypto.randomUUID(),
      role: 'user',
      parts: userParts as UIMessage['parts'],
    };
    const initialMessages = [
      ...(baseConversation.messages as UIMessage[]),
      userMessage,
    ];
    let workingConversation: ConversationSummary = {
      ...baseConversation,
      messages: initialMessages,
      updatedAt: Date.now(),
    };

    upsertBackgroundConversation(workingConversation);
    persistDetachedConversation(workingConversation, true);
    broadcastDetachedConversationState(workingConversation, true, true);
    setConversationStreaming(baseConversation.id, true);

    const controller = new AbortController();
    backgroundStreamControllersRef.current[baseConversation.id] = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: initialMessages,
          model: baseConversation.model || model,
          profileId: baseConversation.profileId || profileId,
          useAutoRouting: typeof baseConversation.useAutoRouting === 'boolean'
            ? baseConversation.useAutoRouting
            : isAutoRouting,
          conversationId: baseConversation.id,
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const streamedMessages = readUIMessageStream<UIMessage>({
        stream: toUIMessageChunkStream(response.body),
        terminateOnError: true,
      });
      for await (const assistantMessage of streamedMessages) {
        workingConversation = {
          ...workingConversation,
          messages: mergeAssistantMessage(workingConversation.messages as UIMessage[], assistantMessage),
          updatedAt: Date.now(),
        };
        upsertBackgroundConversation(workingConversation);
        persistDetachedConversation(workingConversation);
        broadcastDetachedConversationState(workingConversation, true);
      }
      persistDetachedConversation(workingConversation, true);
      broadcastDetachedConversationState(workingConversation, false, true);
      markConversationUnread(baseConversation.id);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const text = aborted
        ? '⊘ Canceled by user'
        : `❌ Error: ${error instanceof Error ? error.message : 'Request failed'}`;
      const assistantMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text }],
      };
      workingConversation = {
        ...workingConversation,
        messages: [...(workingConversation.messages as UIMessage[]), assistantMessage],
        updatedAt: Date.now(),
      };
      upsertBackgroundConversation(workingConversation);
      persistDetachedConversation(workingConversation, true);
      broadcastDetachedConversationState(workingConversation, false, true);
      markConversationUnread(baseConversation.id);
    } finally {
      delete backgroundStreamControllersRef.current[baseConversation.id];
      setConversationStreaming(baseConversation.id, false);
    }
  }, [
    isAutoRouting,
    broadcastDetachedConversationState,
    markConversationUnread,
    model,
    persistDetachedConversation,
    profileId,
    setConversationStreaming,
    upsertBackgroundConversation,
  ]);
  const regenerateDetachedConversationAt = useCallback(async (assistantMessageId: string) => {
    if (!detachedConversation) {
      return;
    }
    const sourceConversation = backgroundConversations[detachedConversation.id] ?? detachedConversation;
    if (!sourceConversation.id || backgroundStreamControllersRef.current[sourceConversation.id]) {
      return;
    }
    const sourceMessages = sourceConversation.messages as UIMessage[];
    const assistantIndex = sourceMessages.findIndex((message) => message.id === assistantMessageId && message.role === 'assistant');
    if (assistantIndex < 0) {
      return;
    }
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && sourceMessages[userIndex].role !== 'user') {
      userIndex -= 1;
    }
    if (userIndex < 0) {
      return;
    }
    const sourceUserMessage = sourceMessages[userIndex];
    if (!sourceUserMessage || sourceUserMessage.role !== 'user') {
      return;
    }

    const truncatedConversation: ConversationSummary = {
      ...sourceConversation,
      messages: sourceMessages.slice(0, userIndex),
      updatedAt: Date.now(),
    };
    upsertBackgroundConversation(truncatedConversation);
    persistDetachedConversation(truncatedConversation, true);

    await startDetachedConversationStream(
      truncatedConversation,
      sourceUserMessage.parts as Array<{ type: string; text?: string; url?: string; mediaType?: string }>,
      sourceUserMessage.id,
    );
  }, [
    backgroundConversations,
    detachedConversation,
    persistDetachedConversation,
    startDetachedConversationStream,
    upsertBackgroundConversation,
  ]);
  const sendDetachedConversationMessage = useCallback(async () => {
    if (!detachedConversation) {
      return;
    }
    const trimmed = detachedConversationInput.trim();
    if (!trimmed && pendingAttachments.length === 0) {
      return;
    }

    let textContent = detachedConversationInput;
    if (pendingAttachments.length > 0) {
      const textAttachments = pendingAttachments
        .filter((attachment) => attachment.type === 'document' && attachment.textContent)
        .map((attachment) => `\n\n[File: ${attachment.name}]\n\`\`\`\n${attachment.textContent}\n\`\`\``)
        .join('');
      textContent += textAttachments;
    }
    const imageParts = pendingAttachments
      .filter((attachment) => attachment.type === 'image' && attachment.dataUrl)
      .map((attachment) => ({
        type: 'file',
        url: attachment.dataUrl!,
        mediaType: attachment.mimeType,
      }));
    clearAttachments();
    setDetachedConversationInput('');

    const userParts: Array<{ type: string; text?: string; url?: string; mediaType?: string }> = [
      { type: 'text', text: textContent },
      ...imageParts,
    ];
    const sourceConversation = backgroundConversations[detachedConversation.id] ?? detachedConversation;
    await startDetachedConversationStream(sourceConversation, userParts);
  }, [
    backgroundConversations,
    clearAttachments,
    detachedConversation,
    detachedConversationInput,
    pendingAttachments,
    startDetachedConversationStream,
  ]);
  const stopDisplayedConversation = useCallback(() => {
    if (detachedConversation) {
      const controller = backgroundStreamControllersRef.current[detachedConversation.id];
      if (controller) {
        controller.abort();
        return;
      }
    }
    stop();
  }, [detachedConversation, stop]);

  useEffect(() => () => {
    for (const controller of Object.values(backgroundStreamControllersRef.current)) {
      controller.abort();
    }
    backgroundStreamControllersRef.current = {};
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const apply = (pref: ThemePref) => {
      const root = document.documentElement;
      const isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', isDark);
    };

    const stored = window.localStorage.getItem('ai-chat:theme') as ThemePref | null;
    const initial: ThemePref = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    setThemePref(initial);
    apply(initial);

    // Track current pref in a ref so the media/storage listeners stay fresh
    let currentPref = initial;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMedia = () => {
      if (currentPref === 'system') {
        apply('system');
      }
    };
    media.addEventListener?.('change', onMedia);

    // Cross-tab sync: when another tab saves the theme, apply it here too
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== 'ai-chat:theme' || !ev.newValue) {
        return;
      }
      const next = ev.newValue as ThemePref;
      if (next !== 'light' && next !== 'dark' && next !== 'system') {
        return;
      }
      currentPref = next;
      setThemePref(next);
      apply(next);
    };
    window.addEventListener('storage', onStorage);

    return () => {
      media.removeEventListener?.('change', onMedia);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const cycleTheme = useCallback(() => {
    const next: ThemePref = themePref === 'light' ? 'dark' : themePref === 'dark' ? 'system' : 'light';
    setThemePref(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('ai-chat:theme', next);
      const isDark = next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', isDark);
    }
  }, [themePref]);

  useEffect(() => {
    if (!toolsOpen) {
      return;
    }
    void (async () => {
      const res = await fetch('/api/tools');
      const data = (await res.json()) as { tools: ToolCatalogItem[] };
      setToolsCatalog(data.tools ?? []);
    })();
  }, [toolsOpen]);

  useEffect(() => {
    document.documentElement.classList.add('chat-page-open');
    document.body.classList.add('chat-page-open');
    return () => {
      document.documentElement.classList.remove('chat-page-open');
      document.body.classList.remove('chat-page-open');
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const visualViewport = window.visualViewport;
    const updateViewportHeight = () => {
      if (viewportResizeRaf.current !== null) {
        window.cancelAnimationFrame(viewportResizeRaf.current);
      }
      viewportResizeRaf.current = window.requestAnimationFrame(() => {
        const vv = window.visualViewport;
        const nextTop = Math.max(0, Math.round(vv?.offsetTop ?? 0));
        const nextHeight = Math.round(vv?.height ?? window.innerHeight);
        setViewportTop(nextTop);
        setViewportHeight(nextHeight);
        viewportResizeRaf.current = null;
      });
    };

    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    visualViewport?.addEventListener('resize', updateViewportHeight);
    visualViewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
      visualViewport?.removeEventListener('resize', updateViewportHeight);
      visualViewport?.removeEventListener('scroll', updateViewportHeight);
      if (viewportResizeRaf.current !== null) {
        window.cancelAnimationFrame(viewportResizeRaf.current);
      }
    };
  }, []);

  const selectedModel = availableModels.find((m) => m.id === model);
  const contextPercent = Math.round(contextStats.percentage * 100);
  const thresholdPercent = Math.round(contextPolicy.compactionThreshold * 100);
  const warningPercent = contextPolicy.mode === 'off' ? 90 : thresholdPercent;
  const dangerPercent = contextPolicy.mode === 'off' ? 97 : Math.min(98, thresholdPercent + 15);
  const contextBarColor =
    contextPercent >= dangerPercent ? 'bg-red-500' : contextPercent >= warningPercent ? 'bg-yellow-500' : 'bg-blue-500';
  const resolvedDetachedConversation = detachedConversation
    ? (backgroundConversations[detachedConversation.id] ?? detachedConversation)
    : null;
  const isDetachedConversationView = resolvedDetachedConversation !== null;
  const displayedConversationId = isDetachedConversationView ? resolvedDetachedConversation.id : conversationId;
  const displayedMessages = isDetachedConversationView
    ? resolvedDetachedConversation.messages as typeof messages
    : messages;
  const isDisplayedStreamingFromAnyTab = Boolean(streamingConversationsByTab[displayedConversationId]?.length);
  const typingConversationIds = Array.from(new Set([
    ...Object.keys(streamingConversationsByTab),
    ...backgroundStreamingConversationIds,
    ...(isLoading ? [conversationId] : []),
  ]));
  const backgroundStreamingSet = new Set(backgroundStreamingConversationIds);
  const isDisplayedStreaming = isDetachedConversationView
    ? (backgroundStreamingSet.has(displayedConversationId) || isDisplayedStreamingFromAnyTab)
    : (isLoading || isDisplayedStreamingFromAnyTab);
  const effectiveSidebarOpen = sidebarOpen || (isLoading && inMemorySidebarOpen === true);
  const hasAnyStreamingConversation = isLoading
    || remoteIsStreaming
    || backgroundStreamingConversationIds.length > 0
    || Object.keys(streamingConversationsByTab).length > 0;

  useEffect(() => {
    setUnreadConversationIdsSynced((prev) => prev.includes(displayedConversationId)
      ? prev.filter((id) => id !== displayedConversationId)
      : prev);
  }, [displayedConversationId, setUnreadConversationIdsSynced]);

  useEffect(() => {
    if (!isLoading || displayedConversationId === conversationId) {
      return;
    }
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant) {
      return;
    }
    setUnreadConversationIdsSynced((prev) => (prev.includes(conversationId) ? prev : [...prev, conversationId]));
  }, [conversationId, displayedConversationId, isLoading, messages, setUnreadConversationIdsSynced]);

  return (
    <div
      className="fixed inset-x-0 overflow-hidden overscroll-none bg-white dark:bg-gray-950"
      style={{
        top: `${viewportTop}px`,
        height: viewportHeight ? `${viewportHeight}px` : '100dvh',
      }}
    >
      <FaviconStatus awaitingResponse={hasAnyStreamingConversation} />
      <ConversationSidebar
        open={effectiveSidebarOpen}
        currentConversationId={displayedConversationId}
        currentConversationHasMessages={displayedMessages.length > 0}
        unreadConversationIds={unreadConversationIds}
        typingConversationIds={typingConversationIds}
        showAiConversationTitles={aiConversationTitlesEnabled}
        onSelectConversation={(conv) => {
          blurActiveElement();
          setUnreadConversationIdsSynced((prev) => prev.includes(conv.id)
            ? prev.filter((id) => id !== conv.id)
            : prev);
          const selectedConversation = backgroundConversations[conv.id] ?? conv;
          if ((isLoading || backgroundStreamingSet.has(selectedConversation.id)) && conv.id !== conversationId) {
            setDetachedConversation(selectedConversation);
            setDetachedConversationInput('');
            syncConversationSelection(selectedConversation);
            closeSidebar('select-while-streaming');
            return;
          }
          if (conv.id === conversationId) {
            setDetachedConversation(null);
            setDetachedConversationInput('');
            return;
          }
          setDetachedConversation(null);
          setDetachedConversationInput('');
          loadConversation(selectedConversation);
          closeSidebar('select-conversation');
        }}
        onNewConversation={() => {
          blurActiveElement();
          if (isLoading) {
            const nextConversation: ConversationSummary = {
              id: crypto.randomUUID(),
              title: 'New conversation',
              preview: '',
              model,
              profileId,
              updatedAt: Date.now(),
              messages: [],
              variantsByTurn: {},
              useAutoRouting: isAutoRouting,
            };
            setDetachedConversation(nextConversation);
            setDetachedConversationInput('');
            upsertBackgroundConversation(nextConversation);
            syncConversationSelection(nextConversation);
            closeSidebar('new-conversation-while-streaming');
            return;
          }
          setDetachedConversation(null);
          setDetachedConversationInput('');
          clearConversation();
          closeSidebar('new-conversation');
        }}
        isStreaming={false}
        syncHistoryUpdates={shouldSyncHistory}
      />
      <div
        className="absolute inset-0 z-0 flex flex-col overflow-hidden transition-transform duration-200 will-change-transform"
        style={{ transform: effectiveSidebarOpen ? `translateX(${SIDEBAR_WIDTH_REM}rem)` : 'translateX(0px)' }}
      >
        {effectiveSidebarOpen && (
          <button
            type="button"
            onClick={() => {
              blurActiveElement();
              closeSidebar('backdrop-click');
            }}
            aria-label="Close history"
            className="absolute inset-0 z-10 bg-transparent"
          />
        )}
        <header className="flex flex-shrink-0 flex-col border-b border-gray-200 px-4 py-2.5 gap-y-1.5 dark:border-gray-800">
          {/* Always-visible row: title on left, icons on right */}
          <div className="flex items-center justify-between">
            {/* Left: sidebar toggle + title */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSidebar(effectiveSidebarOpen);
                }}
                title={effectiveSidebarOpen ? 'Close history' : 'Open history'}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                {effectiveSidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
              </button>
              <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {process.env.NEXT_PUBLIC_APP_NAME ?? 'AI Chat'}
              </h1>
              {wasCompacted && (
                <span className="flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">
                  <Zap className="h-3 w-3" />
                  {compactionMode === 'truncate'
                    ? 'Context truncated'
                    : compactionMode === 'running-summary'
                      ? 'Context running summary'
                      : 'Context summarized'}
                </span>
              )}
            </div>

            {/* Middle: selects — hidden on this row, shown inline when wide enough */}
            <div className="hidden sm:flex items-center gap-2 ml-2">
              <div className="flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                <input
                  id="auto-routing-toggle-wide"
                  type="checkbox"
                  checked={mounted ? isAutoRouting : true}
                  onChange={(e) => setIsAutoRouting(e.target.checked)}
                />
                <label htmlFor="auto-routing-toggle-wide" className="cursor-pointer select-none">
                Auto
                </label>
              </div>
              <div className="relative inline-flex items-center">
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  disabled={mounted ? isAutoRouting : true}
                  className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-6 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  style={{ width: 'auto', fieldSizing: 'content' } as React.CSSProperties}
                  title="Active profile"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
              </div>
              <div className="relative inline-flex items-center">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={mounted ? isAutoRouting : true}
                  className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-6 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  style={{ width: 'auto', fieldSizing: 'content' } as React.CSSProperties}
                >
                  {availableModels.map((m) => (
                    <option key={m.provider + '/' + m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
              </div>
            </div>

            {/* Right: icon buttons */}
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={clearConversation}
                title="New conversation"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <MessageSquarePlus className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={cycleTheme}
                title={`Theme: ${themePref} (click to cycle)`}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                {themePref === 'light' ? <Sun className="h-4 w-4" /> : themePref === 'dark' ? <Moon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
              </button>

              <Link
                href="/settings"
                title="Settings"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <Settings className="h-4 w-4" />
              </Link>

              <LogoutButton />
            </div>
          </div>

          {/* Second row: selects on narrow viewports (below sm breakpoint) */}
          <div className="flex sm:hidden items-center gap-2">
            <div className="flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
              <input
                id="auto-routing-toggle"
                type="checkbox"
                checked={mounted ? isAutoRouting : true}
                onChange={(e) => setIsAutoRouting(e.target.checked)}
              />
              <label htmlFor="auto-routing-toggle" className="cursor-pointer select-none">
              Auto
              </label>
            </div>
            <div className="relative inline-flex items-center">
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                disabled={mounted ? isAutoRouting : true}
                className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-6 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                style={{ width: 'auto', fieldSizing: 'content' } as React.CSSProperties}
                title="Active profile"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
            </div>
            <div className="relative inline-flex items-center">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={mounted ? isAutoRouting : true}
                className="appearance-none rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-6 text-xs text-gray-700 outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                style={{ width: 'auto', fieldSizing: 'content' } as React.CSSProperties}
              >
                {availableModels.map((m) => (
                  <option key={m.provider + '/' + m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {routeToast && (
                <div key={routeToastKey} className="mx-4 mt-2 overflow-hidden rounded border border-amber-300 bg-amber-50 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <div className="px-3 py-2">
                    {routeToast.split('\n').map((line, i) => (
                      <div key={i} className={i === 0 ? 'font-medium' : 'mt-0.5'}>{line}</div>
                    ))}
                  </div>
                  <div className="h-0.5 w-full origin-right animate-toast-drain bg-amber-500/70 dark:bg-amber-300/70" />
                </div>
              )}
              {!isDetachedConversationView && (
                <SubAgentPanel runs={subAgentRuns} syncDismissState={shouldSyncSubAgentPanel} />
              )}
              <MessageList
                conversationKey={displayedConversationId}
                messages={displayedMessages}
                isLoading={isDisplayedStreaming}
                toolCallStates={isDetachedConversationView ? {} : toolCallStates}
                assistantVariantMeta={isDetachedConversationView ? {} : assistantVariantMeta}
                hiddenAssistantMessageIds={isDetachedConversationView ? [] : hiddenAssistantMessageIds}
                onSwitchVariant={(turnKey, direction) => {
                  if (isDetachedConversationView) {
                    return;
                  }
                  switchAssistantVariant(turnKey, direction);
                }}
                onRegenerate={(assistantMessageId) => {
                  if (isDetachedConversationView) {
                    void regenerateDetachedConversationAt(assistantMessageId);
                    return;
                  }
                  regenerateAssistantAt(assistantMessageId, model);
                }}
              />
            </div>


            <div
              className="border-t border-gray-100 px-4 pt-2 dark:border-gray-800"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <MessageInput
                value={isDetachedConversationView ? detachedConversationInput : (typeof input === 'string' ? input : '')}
                onChange={isDetachedConversationView
                  ? ((e: ChangeEvent<HTMLTextAreaElement>) => setDetachedConversationInput(e.target.value))
                  : setInput as (e: ChangeEvent<HTMLTextAreaElement>) => void}
                onSend={isDetachedConversationView ? sendDetachedConversationMessage : handleSend}
                onStop={stopDisplayedConversation}
                isLoading={isDisplayedStreaming}
                pendingAttachments={pendingAttachments}
                onAddAttachment={addAttachment}
                onRemoveAttachment={removeAttachment}
              />

              <div className="mt-2 flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                      <div
                        className={cn('h-full rounded-full transition-all', contextBarColor)}
                        style={{ width: `${Math.min(contextPercent, 100)}%` }}
                      />
                    </div>
                    <span>
                Context: {formatTokens(contextStats.used)} / {formatTokens(contextStats.limit)} tokens
                    </span>
                  </div>
                  {contextPercent >= warningPercent && (
                    <span className="text-yellow-500">
                      {contextPolicy.mode === 'off'
                        ? '⚠ Approaching limit'
                        : `⚠ Compaction threshold (${thresholdPercent}%)`}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {mounted && selectedModel && (
                    <>
                      {selectedModel.supportsVision && <span>👁 Vision</span>}
                      {selectedModel.supportsVision && selectedModel.supportsTools && <span className="mx-1">·</span>}
                      {selectedModel.supportsTools && (
                        <button
                          type="button"
                          onClick={() => setToolsOpen(true)}
                          className="rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                    🔧 Tools
                        </button>
                      )}
                    </>
                  )}
                  <span className="flex items-center gap-1">
                    <Info className="h-3 w-3" />
              Shift+Enter for newline
                  </span>
                </div>
              </div>
            </div>

            {toolsOpen && (
              <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => setToolsOpen(false)}>
                <div
                  className="max-h-[75vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-4 text-gray-900 shadow-2xl dark:bg-gray-900 dark:text-gray-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Available Tools</h3>
                    <button type="button" onClick={() => setToolsOpen(false)} className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {toolsCatalog.map((tool) => {
                      const paramRows = getToolParameterRows(tool.inputSchema);
                      return (
                        <details key={tool.name} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                          <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                            {tool.icon} {tool.name} <span className="ml-2 text-xs text-gray-500">~{tool.expectedDurationMs}ms</span>
                          </summary>
                          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{tool.description}</p>
                          <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                            <div>
                              <div className="mb-1 font-medium text-gray-500">Inputs</div>
                              {paramRows.length > 0 ? (
                                <div className="space-y-1">
                                  {paramRows.map((row, idx) => (
                                    <div key={`${tool.name}:${row.key}:${idx}`} className="rounded border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800/60">
                                      <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: `${row.depth * 12}px` }}>
                                        <code className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{row.key}</code>
                                        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-700 dark:bg-gray-700 dark:text-gray-200">{row.type}</span>
                                        <span className={cn(
                                          'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                                          row.required
                                            ? 'bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300'
                                            : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
                                        )}>
                                          {row.required ? 'required' : 'optional'}
                                        </span>
                                      </div>
                                      {(row.description || row.note) && (
                                        <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-300" style={{ paddingLeft: `${row.depth * 12}px` }}>
                                          {[row.description, row.note].filter(Boolean).join(' • ')}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <ul className="list-disc pl-4">
                                  {tool.inputs.map((i) => <li key={i}>{i}</li>)}
                                </ul>
                              )}
                            </div>
                            <div>
                              <div className="mb-1 font-medium text-gray-500">Outputs</div>
                              <ul className="list-disc pl-4">
                                {tool.outputs.map((o) => <li key={o}>{o}</li>)}
                              </ul>
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
