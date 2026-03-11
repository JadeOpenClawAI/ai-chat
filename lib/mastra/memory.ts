import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

const DEFAULT_MASTRA_MEMORY_URL = 'file:./config/mastra-memory.sqlite';
const MASTRA_MEMORY_URL = process.env.MASTRA_MEMORY_DB_URL?.trim() || DEFAULT_MASTRA_MEMORY_URL;
const STORE_ID = 'ai-chat-mastra-memory';

let runtimePromise:
  | Promise<{
    store: LibSQLStore;
    memory: Memory;
  }>
  | null = null;

export async function getMastraMemoryRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const store = new LibSQLStore({
        id: STORE_ID,
        url: MASTRA_MEMORY_URL,
      });
      await store.init();

      const memory = new Memory({
        storage: store,
        options: {
          lastMessages: false,
        },
      });

      return { store, memory };
    })();
  }

  return runtimePromise;
}

export async function getMastraMemory() {
  return (await getMastraMemoryRuntime()).memory;
}

export async function getMastraMemoryStore() {
  return (await getMastraMemoryRuntime()).store;
}
