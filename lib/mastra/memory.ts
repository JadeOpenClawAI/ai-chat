import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

const DEFAULT_MASTRA_MEMORY_URL = 'file:./config/mastra-memory.sqlite';
const MASTRA_MEMORY_URL = process.env.MASTRA_MEMORY_DB_URL?.trim() || DEFAULT_MASTRA_MEMORY_URL;
const STORE_ID = 'ai-chat-mastra-memory';

interface MastraMemoryEmbedderConfig {
  key: string;
  model: unknown;
  options?: unknown;
}

let runtimePromise:
  | Promise<{
    store: LibSQLStore;
    vector: LibSQLVector;
  }>
  | null = null;
const memoryPromises = new Map<string, Promise<Memory>>();

export interface WipeMastraMemoryResult {
  wipedThreadCount: number;
  wipedVectorIndexCount: number;
}

export async function getMastraMemoryRuntime(embedder?: MastraMemoryEmbedderConfig) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const store = new LibSQLStore({
        id: STORE_ID,
        url: MASTRA_MEMORY_URL,
      });
      await store.init();

      const vector = new LibSQLVector({
        id: `${STORE_ID}-vector`,
        url: MASTRA_MEMORY_URL,
      });

      return { store, vector };
    })();
  }

  const runtime = await runtimePromise;
  const key = embedder?.key ?? 'default';
  if (!memoryPromises.has(key)) {
    memoryPromises.set(key, Promise.resolve(new Memory({
      storage: runtime.store,
      vector: embedder ? runtime.vector : false,
      ...(embedder ? { embedder: embedder.model as never } : {}),
      ...(embedder?.options ? { embedderOptions: embedder.options as never } : {}),
      options: {
        lastMessages: false,
      },
    })));
  }

  const memory = await memoryPromises.get(key)!;
  return { ...runtime, memory };
}

export async function getMastraMemory(embedder?: MastraMemoryEmbedderConfig) {
  return (await getMastraMemoryRuntime(embedder)).memory;
}

export async function getMastraMemoryStore() {
  return (await getMastraMemoryRuntime()).store;
}

export async function wipeMastraMemory(): Promise<WipeMastraMemoryResult> {
  const runtime = await getMastraMemoryRuntime();
  const listedThreads = await runtime.memory.listThreads({ perPage: false });
  const vectorIndexes = await runtime.vector.listIndexes().catch(() => []);
  const memoryStore = runtime.store.stores.memory as { dangerouslyClearAll?: () => Promise<void> } | undefined;

  if (!memoryStore?.dangerouslyClearAll) {
    throw new Error('Mastra memory store does not support full wipe.');
  }

  await memoryStore.dangerouslyClearAll();

  for (const indexName of vectorIndexes) {
    await runtime.vector.deleteIndex({ indexName });
  }

  return {
    wipedThreadCount: listedThreads.threads.length,
    wipedVectorIndexCount: vectorIndexes.length,
  };
}
