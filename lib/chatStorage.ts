import type { TurnVariants } from '@/hooks/useChat';

const DB_NAME = 'ai-chat';
const DB_VERSION = 2;
const STORE_NAME = 'state';
const STATE_KEY = 'chat';
const BROADCAST_CHANNEL = 'ai-chat:sync';
const HISTORY_STORE = 'conversations';

export interface ChatState {
  conversationId: string;
  messages: unknown[];
  profileId: string;
  model: string;
  useAutoRouting: boolean;
  routeToast: string;
  routeToastKey: number;
  variantsByTurn: Record<string, TurnVariants>;
  updatedAt: number;
  isStreaming?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
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
  | { type: 'control-action'; action: 'stop'; conversationId: string; updatedAt: number };

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

function extractTitleAndPreview(messages: unknown[]): { title: string; preview: string } {
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
    const { title, preview } = extractTitleAndPreview(state.messages);
    const entry: ConversationSummary = {
      id: state.conversationId,
      title,
      preview,
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
