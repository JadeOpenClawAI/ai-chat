import type { TurnVariants } from '@/hooks/useChat';
import type { ToolCallMeta } from '@/lib/types';

const DB_NAME = 'ai-chat';
const DB_VERSION = 2;
const STORE_NAME = 'state';
const STATE_KEY = 'chat';
const BROADCAST_CHANNEL = 'ai-chat:sync';
const HISTORY_STORE = 'conversations';

export interface ChatState {
  conversationId: string;
  selectionUpdatedAt?: number;
  messages: unknown[];
  profileId: string;
  model: string;
  useAutoRouting: boolean;
  routeToast: string;
  routeToastKey: number;
  variantsByTurn: Record<string, TurnVariants>;
  conversationTitle?: string;
  conversationTitleVersion?: number;
  updatedAt: number;
  isStreaming?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  aiTitle?: string;
  aiTitleVersion?: number;
  model: string;
  profileId: string;
  updatedAt: number;
  messages: unknown[];
  variantsByTurn: Record<string, TurnVariants>;
  useAutoRouting: boolean;
}

type CrossTabMessage =
  | { type: 'chat-state'; state: ChatState }
  | { type: 'history-mutated'; action: 'save' | 'delete' | 'delete-all'; conversationId?: string; updatedAt: number }
  | { type: 'control-action'; action: 'stop'; conversationId: string; updatedAt: number }
  | { type: 'tool-state'; conversationId: string; toolState: ToolCallMeta; updatedAt: number };

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      void event;
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(db: IDBDatabase, storeName: string, key: string | null, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = key !== null ? store.put(value, key) : store.put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function idbClearStore(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB();
  }
  return dbPromise;
}

export async function readChatState(): Promise<ChatState | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const db = await getDB();
    const state = await idbGet<ChatState>(db, STORE_NAME, STATE_KEY);
    return state ?? null;
  } catch {
    return null;
  }
}

export async function writeChatState(state: ChatState): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const db = await getDB();
    await idbPut(db, STORE_NAME, STATE_KEY, state);
  } catch {
    // Silent fail — data will be re-persisted on next change
  }
}

export async function clearChatState(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const db = await getDB();
    await idbDelete(db, STORE_NAME, STATE_KEY);
  } catch {
    // Silent fail
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

function extractFallbackTitleAndPreview(messages: unknown[]): { title: string; preview: string } {
  const typed = messages as Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
  const firstUser = typed.find((m) => m.role === 'user');
  const text = firstUser?.parts?.find((p) => p.type === 'text')?.text ?? '';
  const title = text.slice(0, 60).trim() || 'New conversation';
  const preview = text.slice(0, 120).trim();
  return { title, preview };
}

export async function saveConversationToHistory(state: ChatState): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  if (!state.messages || state.messages.length === 0) {
    return;
  }
  try {
    const db = await getDB();
    const existing = await idbGet<ConversationSummary>(db, HISTORY_STORE, state.conversationId);
    const { title: fallbackTitle, preview } = extractFallbackTitleAndPreview(state.messages);
    const incomingAiTitle = state.conversationTitle?.trim();
    const incomingAiTitleVersion = Number.isFinite(state.conversationTitleVersion)
      ? Math.max(0, Math.floor(state.conversationTitleVersion ?? 0))
      : undefined;
    const existingAiTitle = existing?.aiTitle?.trim();
    const existingAiTitleVersion = Number.isFinite(existing?.aiTitleVersion)
      ? Math.max(0, Math.floor(existing?.aiTitleVersion ?? 0))
      : 0;

    let aiTitle = existingAiTitle;
    let aiTitleVersion = existingAiTitleVersion;
    if (incomingAiTitle) {
      const nextVersion = incomingAiTitleVersion ?? existingAiTitleVersion;
      if (!existingAiTitle || nextVersion >= existingAiTitleVersion) {
        aiTitle = incomingAiTitle;
        aiTitleVersion = nextVersion;
      }
    }

    const entry: ConversationSummary = {
      id: state.conversationId,
      title: aiTitle || fallbackTitle,
      preview,
      aiTitle: aiTitle || undefined,
      aiTitleVersion: aiTitle ? aiTitleVersion : undefined,
      model: state.model,
      profileId: state.profileId,
      updatedAt: state.updatedAt,
      messages: state.messages,
      variantsByTurn: state.variantsByTurn,
      useAutoRouting: state.useAutoRouting,
    };
    await idbPut(db, HISTORY_STORE, null, entry);
    broadcastHistoryMutation('save', state.conversationId);
  } catch {
    // Silent fail
  }
}

export async function upsertConversationAiTitle(
  conversationId: string,
  title: string,
  aiTitleVersion?: number,
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  const nextTitle = title.trim();
  if (!nextTitle) {
    return;
  }
  try {
    const db = await getDB();
    const existing = await idbGet<ConversationSummary>(db, HISTORY_STORE, conversationId);
    if (!existing) {
      return;
    }
    const incomingVersion = Number.isFinite(aiTitleVersion)
      ? Math.max(0, Math.floor(aiTitleVersion ?? 0))
      : Number.isFinite(existing.aiTitleVersion)
        ? Math.max(0, Math.floor(existing.aiTitleVersion ?? 0))
        : 0;
    const currentVersion = Number.isFinite(existing.aiTitleVersion)
      ? Math.max(0, Math.floor(existing.aiTitleVersion ?? 0))
      : 0;

    if (
      typeof existing.aiTitle === 'string'
      && existing.aiTitle.trim().length > 0
      && currentVersion > incomingVersion
    ) {
      return;
    }
    if (existing.aiTitle === nextTitle && currentVersion === incomingVersion) {
      return;
    }

    const nextEntry: ConversationSummary = {
      ...existing,
      title: nextTitle,
      aiTitle: nextTitle,
      aiTitleVersion: incomingVersion,
    };
    await idbPut(db, HISTORY_STORE, null, nextEntry);
    broadcastHistoryMutation('save', conversationId);
  } catch {
    // Silent fail
  }
}

export async function readConversationFromHistory(id: string): Promise<ConversationSummary | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const db = await getDB();
    const existing = await idbGet<ConversationSummary>(db, HISTORY_STORE, id);
    return existing ?? null;
  } catch {
    return null;
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const db = await getDB();
    const all = await idbGetAll<ConversationSummary>(db, HISTORY_STORE);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteConversation(id: string): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const db = await getDB();
    await idbDelete(db, HISTORY_STORE, id);
    broadcastHistoryMutation('delete', id);
  } catch {
    // Silent fail
  }
}

export async function deleteAllConversations(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const db = await getDB();
    await idbClearStore(db, HISTORY_STORE);
    broadcastHistoryMutation('delete-all');
  } catch {
    // Silent fail
  }
}

// ── Cross-tab sync via BroadcastChannel ──────────────────────────────────────

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') {
    return null;
  }
  if (!channel) {
    try {
      channel = new BroadcastChannel(BROADCAST_CHANNEL);
    } catch {
      return null;
    }
  }
  return channel;
}

export function broadcastStateUpdate(state: ChatState): void {
  const msg: CrossTabMessage = { type: 'chat-state', state };
  getChannel()?.postMessage(msg);
}

export function broadcastHistoryMutation(
  action: 'save' | 'delete' | 'delete-all',
  conversationId?: string,
): void {
  const msg: CrossTabMessage = {
    type: 'history-mutated',
    action,
    conversationId,
    updatedAt: Date.now(),
  };
  getChannel()?.postMessage(msg);
}

export function broadcastControlAction(
  action: 'stop',
  conversationId: string,
): void {
  const msg: CrossTabMessage = {
    type: 'control-action',
    action,
    conversationId,
    updatedAt: Date.now(),
  };
  getChannel()?.postMessage(msg);
}

export function broadcastToolStateUpdate(
  conversationId: string,
  toolState: ToolCallMeta,
): void {
  const msg: CrossTabMessage = {
    type: 'tool-state',
    conversationId,
    toolState,
    updatedAt: Date.now(),
  };
  getChannel()?.postMessage(msg);
}

export function onCrossTabUpdate(callback: (state: ChatState) => void): () => void {
  const ch = getChannel();
  if (!ch) {
    return () => {};
  }
  const handler = (ev: MessageEvent) => {
    const data = ev.data as CrossTabMessage | ChatState;
    if (data && typeof data === 'object' && 'type' in data) {
      if (data.type === 'chat-state') {
        callback(data.state);
      }
      return;
    }
    // Backward compatibility for tabs still posting raw ChatState.
    callback(data as ChatState);
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

export function onHistoryMutation(
  callback: (event: { action: 'save' | 'delete' | 'delete-all'; conversationId?: string; updatedAt: number }) => void,
): () => void {
  const ch = getChannel();
  if (!ch) {
    return () => {};
  }
  const handler = (ev: MessageEvent) => {
    const data = ev.data as CrossTabMessage;
    if (!data || typeof data !== 'object' || !('type' in data)) {
      return;
    }
    if (data.type !== 'history-mutated') {
      return;
    }
    callback({ action: data.action, conversationId: data.conversationId, updatedAt: data.updatedAt });
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

export function onControlAction(
  callback: (event: { action: 'stop'; conversationId: string; updatedAt: number }) => void,
): () => void {
  const ch = getChannel();
  if (!ch) {
    return () => {};
  }
  const handler = (ev: MessageEvent) => {
    const data = ev.data as CrossTabMessage;
    if (!data || typeof data !== 'object' || !('type' in data)) {
      return;
    }
    if (data.type !== 'control-action') {
      return;
    }
    callback({ action: data.action, conversationId: data.conversationId, updatedAt: data.updatedAt });
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

export function onToolStateUpdate(
  callback: (event: { conversationId: string; toolState: ToolCallMeta; updatedAt: number }) => void,
): () => void {
  const ch = getChannel();
  if (!ch) {
    return () => {};
  }
  const handler = (ev: MessageEvent) => {
    const data = ev.data as CrossTabMessage;
    if (!data || typeof data !== 'object' || !('type' in data)) {
      return;
    }
    if (data.type !== 'tool-state') {
      return;
    }
    callback({
      conversationId: data.conversationId,
      toolState: data.toolState,
      updatedAt: data.updatedAt,
    });
  };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
