import { Agent } from '@mastra/core/agent';
import type { ToolAction, ToolExecutionContext } from '@mastra/core/tools';
import type { MemoryConfig } from '@mastra/core/memory';
import { getMastraMemory } from './memory';
import { MASTRA_MEMORY_RESOURCE_ID } from './keys';

export interface MastraAgentConfig {
  id: string;
  name: string;
  instructions: string;
  model: unknown;
  tools?: Record<string, ToolAction<unknown, unknown, unknown, unknown, ToolExecutionContext<unknown, unknown, unknown>, string, unknown>>;
}

export interface MastraCallMemory {
  threadId: string;
  readOnly: boolean;
}

const PRIMARY_MASTRA_LAST_MESSAGES = 10;

export interface MastraTextCallOptions {
  messages: Array<Record<string, unknown>>;
  providerOptions?: unknown;
  modelSettings?: unknown;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  toolChoice?: unknown;
  memory?: MastraCallMemory;
}

export interface MastraModelTimeout {
  totalMs?: number;
  stepMs?: number;
  chunkMs?: number;
}

export const DEFAULT_MODEL_CALL_STEP_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL_CALL_CHUNK_TIMEOUT_MS = 120_000;

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '0') {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveMastraModelTimeout(): MastraModelTimeout {
  const totalMs = parseTimeoutMs(process.env.MODEL_CALL_TOTAL_TIMEOUT_MS);
  const stepMs = parseTimeoutMs(process.env.MODEL_CALL_STEP_TIMEOUT_MS) ?? DEFAULT_MODEL_CALL_STEP_TIMEOUT_MS;
  const chunkMs = parseTimeoutMs(process.env.MODEL_CALL_CHUNK_TIMEOUT_MS) ?? DEFAULT_MODEL_CALL_CHUNK_TIMEOUT_MS;

  return {
    ...(totalMs ? { totalMs } : {}),
    ...(stepMs ? { stepMs } : {}),
    ...(chunkMs ? { chunkMs } : {}),
  };
}

export function buildPrimaryMemoryCall(threadId: string): MastraCallMemory {
  return {
    threadId,
    readOnly: false,
  };
}

export function buildAuxiliaryMemoryCall(threadId: string): MastraCallMemory {
  return {
    threadId,
    readOnly: true,
  };
}

export function assertAuxiliaryMemoryCall(
  label: string,
  memory: MastraCallMemory,
): void {
  if (!memory.readOnly) {
    throw new Error(`${label} must use read-only Mastra memory`);
  }
}

export async function createMastraAgent(config: MastraAgentConfig) {
  const memory = await getMastraMemory();
  return new Agent({
    id: config.id,
    name: config.name,
    instructions: config.instructions,
    model: config.model as never,
    tools: config.tools,
    memory,
  });
}

export async function streamMastraText(
  agentConfig: MastraAgentConfig,
  options: MastraTextCallOptions,
): Promise<string> {
  const agent = await createMastraAgent(agentConfig);
  const result = await agent.stream(options.messages as never, {
    ...(options.memory ? { memory: toMastraMemoryOption(options.memory) } : {}),
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
    ...(options.modelSettings ? { modelSettings: options.modelSettings } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice as never } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    timeout: resolveMastraModelTimeout(),
  } as never);
  return String(await result.text ?? '').trim();
}

export async function streamMastraAuxiliaryText(
  label: string,
  agentConfig: MastraAgentConfig,
  options: Omit<MastraTextCallOptions, 'memory'> & { memory: MastraCallMemory },
): Promise<string> {
  assertAuxiliaryMemoryCall(label, options.memory);
  return streamMastraText(agentConfig, options);
}

export function toMastraMemoryOption(memory: MastraCallMemory): {
  thread: string;
  resource: string;
  options: MemoryConfig;
} {
  return {
    thread: memory.threadId,
    resource: MASTRA_MEMORY_RESOURCE_ID,
    options: {
      lastMessages: memory.readOnly ? false : PRIMARY_MASTRA_LAST_MESSAGES,
      readOnly: memory.readOnly,
    },
  };
}
