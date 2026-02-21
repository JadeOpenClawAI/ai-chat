import type { TurnVariants } from '@/hooks/useChat'

const DB_NAME = 'ai-chat'
const DB_VERSION = 1
const STORE_NAME = 'state'
const STATE_KEY = 'chat'
const BROADCAST_CHANNEL = 'ai-chat:sync'

export interface ChatState {
  conversationId: string
  messages: unknown[]
  profileId: string
  model: string
  useAutoRouting: boolean
  routeToast: string
  routeToastKey: number
  variantsByTurn: Record<string, TurnVariants>
  updatedAt: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB()
  }
  return dbPromise
}

export async function readChatState(): Promise<ChatState | null> {
  if (typeof window === 'undefined') return null
  try {
    const db = await getDB()
    const state = await idbGet<ChatState>(db, STATE_KEY)
    return state ?? null
  } catch {
    return null
  }
}

export async function writeChatState(state: ChatState): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const db = await getDB()
    await idbPut(db, STATE_KEY, state)
  } catch {
    // Silent fail — data will be re-persisted on next change
  }
}

export async function clearChatState(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const db = await getDB()
    await idbDelete(db, STATE_KEY)
  } catch {
    // Silent fail
  }
}

// ── Cross-tab sync via BroadcastChannel ──────────────────────────────────────

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(BROADCAST_CHANNEL)
    } catch {
      return null
    }
  }
  return channel
}

export function broadcastStateUpdate(state: ChatState): void {
  getChannel()?.postMessage(state)
}

export function onCrossTabUpdate(callback: (state: ChatState) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = (ev: MessageEvent) => {
    callback(ev.data as ChatState)
  }
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}
