/* eslint-disable max-len */
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager';
import { maybeSummarizeToolResult, shouldSummarizeToolResult } from '@/lib/ai/summarizer';
import { getChatTools, getToolMetadata } from '@/lib/ai/tools';
import type { StreamAnnotation } from '@/lib/types';
import { z } from 'zod/v3';
import { createTool } from '@mastra/core/tools';
import type { ModelMessage } from '@/lib/chat-protocol';
import { extractLatestUserText, stringifyToolResult, toModelMessages } from '@/lib/chat-messages';
import {
  buildAuxiliaryMemoryCall,
  createMastraAgentWithMemory,
  resolveMastraModelTimeout,
  toMastraMemoryOption,
  type MastraCallMemory,
} from '@/lib/mastra/runtime';
import {
  createChatEventStreamFromMastra,
  createStreamingAnnotationSource,
  getMastraPartType,
  probeMastraStream,
  type MastraTextStreamPart,
} from '@/lib/mastra/streaming';
import { resolveAuthenticatedResourceId, resolveChatThreadId } from '@/lib/mastra/keys';
import { buildScopedPrimaryMemoryCall } from '@/lib/mastra/policy';
import {
  readConfig,
  writeConfig,
  getProfileById,
  composeSystemPrompts,
  mergeSystemPromptLists,
  resolveModelBehavior,
  upsertConversationRoute,
  type RouteTarget,
} from '@/lib/config/store';
import { getLanguageModelForProfile, getModelOptions, getProviderOptionsForCall, type ModelInvocationContext } from '@/lib/ai/providers';
import type { ToolCompactionPolicy } from '@/lib/config/store';
import {
  getAutoTargetsForActivity,
  getPrimaryRouteTarget,
  resolveAutoActivityProfile,
} from '@/lib/ai/activity-routing';
import { isLocationRequestInterruptError } from '@/lib/location/interrupt';
import { createPendingLocationRequest } from '@/lib/location/pending';

// v5: messages use parts arrays; content is kept optional for backward compat (command messages)
const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([z.string(), z.array(z.record(z.unknown()))]).optional(),
      parts: z.array(z.record(z.unknown())).optional(),
    }).passthrough(),
  ),
  model: z.string().optional(),
  profileId: z.string().optional(),
  useAutoRouting: z.boolean().optional(),
  autoActivityId: z.string().optional(),
  systemPrompt: z.string().optional(),
  conversationId: z.string().optional(),
  locationResume: z.object({
    requestId: z.string().optional(),
    status: z.enum(['saved', 'cleared', 'cancelled', 'denied', 'error']),
    message: z.string().optional(),
  }).optional(),
});

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time
- Request on-demand browser geolocation when exact location or timezone context is required
- Launch parallel sub-agents to investigate multiple threads at once when the task benefits from it
- When launching sub-agents, include all required context, constraints, and success criteria in each agent task because sub-agents only see what you pass in the tool input

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
If the user asks for a code example, snippet, template, or "what the code would look like", DO NOT run tools or execute code. Return the example directly.
Only execute code/commands when the user clearly asks you to run, test, or verify execution.
If execution intent is ambiguous, ask a brief clarifying question before running anything.
Be concise but thorough. Use markdown formatting for structure.`;

const SUB_AGENT_TOOL_NAME = 'launch_sub_agents';
const REQUEST_USERS_LOCATION_TOOL_NAME = 'request_users_location';
const SUB_AGENT_RESULT_PREVIEW_MAX_CHARS = 3000;
const SUB_AGENT_MAX_DEPTH = 4;
const EXECUTION_TOOL_NAMES = new Set([
  'code_runner',
  'run_cli',
  'tool_builder',
  'tool_editor',
  'file_writer',
]);
const INTERNAL_TOOL_ICONS: Record<string, string> = {
  [SUB_AGENT_TOOL_NAME]: '🧵',
  [REQUEST_USERS_LOCATION_TOOL_NAME]: '📍',
};

const LaunchSubAgentsInputSchema = z.object({
  objective: z.string().min(1).describe('Parent goal that all sub-agents should support. Include any shared context they must know.'),
  agents: z.array(
    z.object({
      id: z.union([z.string(), z.null()]).optional(),
      label: z.union([z.string(), z.null()]).optional(),
      task: z.string().min(1).describe('Complete standalone task brief for this sub-agent, including required context, constraints, and expected output.'),
    }),
  ).min(1).max(5),
});
type LaunchSubAgentsInput = z.infer<typeof LaunchSubAgentsInputSchema>;

const RequestUsersLocationInputSchema = z.object({
  reason: z.string().min(1).optional(),
});
type RequestUsersLocationInput = z.infer<typeof RequestUsersLocationInputSchema>;

interface SubAgentRecursionContext {
  depth: number;
  maxDepth: number;
  parentRunId?: string;
  parentAgentId?: string;
  parentAgentLabel?: string;
}

interface AgentExecutionLimits {
  maxSteps: number;
  maxSubAgentSteps: number;
}

function isExampleOnlyRequest(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (!value) {
    return false;
  }

  const asksForExample = /\b(example|sample|snippet|template|boilerplate|scaffold|what (?:would|does) .* look like|show me (?:the )?code|how (?:would|do) (?:i|you) .* (?:write|implement|code))\b/i.test(value);
  if (!asksForExample) {
    return false;
  }

  const asksForExecution = /\b(run|execute|test|verify|try it|compile|build|install|lint|benchmark|call it|invoke)\b/i.test(value);
  const explicitlyNoExecution = /\b(do not run|don't run|without running|just show|just print|no execution|example only)\b/i.test(value);

  return explicitlyNoExecution || !asksForExecution;
}

function parseCommand(text: string):
  | { kind: 'profile'; profileId: string }
  | { kind: 'model'; modelId: string }
  | { kind: 'route-primary'; profileId: string; modelId: string }
  | null {
  if (!text.startsWith('/')) {
    return null;
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts[0] === '/profile' && parts[1]) {
    return { kind: 'profile', profileId: parts[1] };
  }
  if (parts[0] === '/model' && parts[1]) {
    return { kind: 'model', modelId: parts[1] };
  }
  if (parts[0] === '/route' && parts[1] === 'primary' && parts[2] && parts[3]) {
    return { kind: 'route-primary', profileId: parts[2], modelId: parts[3] };
  }
  return null;
}

function jsonMessage(content: string) {
  return Response.json({
    command: true,
    commandHandled: true,
    message: content,
  });
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... (truncated ${value.length - maxChars} chars)`;
}

function readToolCallId(chunk: Record<string, unknown> | undefined): string {
  if (!chunk) {
    return '';
  }
  const payload = chunk.payload;
  if (payload && typeof payload === 'object' && typeof (payload as { toolCallId?: unknown }).toolCallId === 'string') {
    return (payload as { toolCallId: string }).toolCallId;
  }
  if (typeof chunk.toolCallId === 'string') {
    return chunk.toolCallId;
  }
  if (typeof chunk.id === 'string') {
    return chunk.id;
  }
  return '';
}

function readToolName(chunk: Record<string, unknown> | undefined): string {
  if (!chunk) {
    return '';
  }
  const payload = chunk.payload;
  if (payload && typeof payload === 'object' && typeof (payload as { toolName?: unknown }).toolName === 'string') {
    return (payload as { toolName: string }).toolName;
  }
  if (typeof chunk.toolName === 'string') {
    return chunk.toolName;
  }
  if (typeof chunk.name === 'string') {
    return chunk.name;
  }
  return '';
}

function readToolResultOutput(chunk: Record<string, unknown> | undefined): unknown {
  if (!chunk) {
    return undefined;
  }
  const payload = chunk.payload;
  if (payload && typeof payload === 'object') {
    if ('result' in payload) {
      return (payload as { result?: unknown }).result;
    }
    if ('output' in payload) {
      return (payload as { output?: unknown }).output;
    }
  }
  if ('result' in chunk) {
    return chunk.result;
  }
  if ('output' in chunk) {
    return chunk.output;
  }
  return undefined;
}

function createSubAgentSystemPrompt(objective: string, label: string, index: number, total: number): string {
  return `You are sub-agent ${index}/${total} for a parent assistant.

Focus only on your assigned task and provide the strongest possible findings for that task.
You do not have access to any parent conversation context beyond the objective and assigned task text below.
Objective: ${objective}
Agent label: ${label}

Output requirements:
- Be concise and high-signal.
- Include assumptions if data is missing.
- Provide a short final recommendation specific to this task.
- Always end with a clear "Final Result" section.`;
}

function joinSystemPrompts(prompts: string[]): string {
  return prompts.join('\n\n').trim();
}

function createLocationResumeSystemPrompt(
  resume: { status: 'saved' | 'cleared' | 'cancelled' | 'denied' | 'error'; message?: string } | undefined,
): string | null {
  if (!resume) {
    return null;
  }

  if (resume.status === 'saved') {
    return 'Browser geolocation was just captured and saved to working memory before this retry. Use the stored location if it is relevant, and do not ask for location again unless the user says it changed.';
  }

  const suffix = resume.message?.trim() ? ` Details: ${resume.message.trim()}` : '';
  return `A browser geolocation request was attempted before this retry, but it did not produce a saved location (status: ${resume.status}). Continue without exact location unless the user explicitly retries.${suffix}`;
}

function composeSubAgentSystemPrompts(
  rootSystemPrompts: string[],
  objective: string,
  label: string,
  index: number,
  total: number,
): string[] {
  const subAgentSystemPrompt = createSubAgentSystemPrompt(objective, label, index, total);
  const normalizedRootPrompts = rootSystemPrompts.filter((prompt) => prompt.trim().length > 0);
  if (normalizedRootPrompts.length === 0) {
    return [subAgentSystemPrompt];
  }
  return [...normalizedRootPrompts, subAgentSystemPrompt];
}

function summarizeSubAgentToolResults(
  steps: Array<{ toolResults?: Array<{ toolName: string; output: unknown }> }>,
): string {
  const lines: string[] = [];
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      lines.push(`- ${result.toolName}: ${truncateText(stringifyToolResult(result.output), 1200)}`);
    }
  }
  return lines.join('\n');
}

function toCompactedAnnotationMessages(
  messages: ModelMessage[],
): Extract<StreamAnnotation, { type: 'context-compacted' }>['messages'] {
  return messages
    .filter((m): m is ModelMessage & { role: 'user' | 'assistant' | 'system' } =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => {
      const content =
        typeof m.content === 'string' || Array.isArray(m.content)
          ? m.content
          : stringifyToolResult(m.content);
      return {
        role: m.role,
        content,
      };
    });
}

function wrapToolsForModelThread(
  tools: Awaited<ReturnType<typeof getChatTools>>,
  invocation: ModelInvocationContext,
  toolCompaction: ToolCompactionPolicy,
  effectiveSystemPrompts: string[],
  rootSystemPrompts: string[],
  userQuery: string,
  emitToolState: (
    toolCallId: string,
    toolName: string,
    state: Extract<StreamAnnotation, { type: 'tool-state' }>['state'],
    extra?: Partial<Omit<Extract<StreamAnnotation, { type: 'tool-state' }>, 'type' | 'toolCallId' | 'toolName' | 'state'>>,
  ) => void,
  emitSubAgentState: (
    annotation: Omit<Extract<StreamAnnotation, { type: 'sub-agent-state' }>, 'type'>,
  ) => void,
  agentExecution: AgentExecutionLimits,
  summarizedByToolCallId: Map<string, boolean>,
  abortSignal: AbortSignal,
  auxiliaryMemory: MastraCallMemory,
  recursionContext: SubAgentRecursionContext,
  locationRequestContext?: {
    enabled: false;
  } | {
    enabled: true;
    resourceId: string;
    conversationId?: string;
    emitAnnotation?: (annotation: StreamAnnotation) => void;
  },
): Awaited<ReturnType<typeof getChatTools>> {
  const wrapped: Record<string, unknown> = {};
  const exampleOnlyRequest = isExampleOnlyRequest(userQuery);

  for (const [toolName, toolDef] of Object.entries(tools as Record<string, unknown>)) {
    if (
      !toolDef ||
      typeof toolDef !== 'object' ||
      typeof (toolDef as { execute?: unknown }).execute !== 'function'
    ) {
      wrapped[toolName] = toolDef;
      continue;
    }

    const execute = (toolDef as { execute: (args: unknown, context?: unknown) => Promise<unknown> }).execute;

    wrapped[toolName] = createTool({
      ...(toolDef as Record<string, unknown>),
      id: typeof (toolDef as { id?: unknown }).id === 'string' ? (toolDef as { id: string }).id : toolName,
      description: typeof (toolDef as { description?: unknown }).description === 'string'
        ? (toolDef as { description: string }).description
        : toolName,
      execute: async (args: unknown, context?: unknown) => {
        if (exampleOnlyRequest && EXECUTION_TOOL_NAMES.has(toolName)) {
          return {
            ok: true,
            skipped: true,
            reason:
              'Execution skipped because the user asked for a code example. Provide the code without running it.',
          };
        }

        const toolCallId =
          typeof (context as { toolCallId?: unknown } | undefined)?.toolCallId === 'string'
            ? ((context as { toolCallId: string }).toolCallId)
            : `${toolName}-${Date.now()}`;

        const rawResult = await execute(args, context);
        if (toolName === SUB_AGENT_TOOL_NAME) {
          // Preserve sub-agent payload fidelity; parent synthesis depends on this structure.
          summarizedByToolCallId.set(toolCallId, false);
          return rawResult;
        }

        const rawResultText = stringifyToolResult(rawResult);
        const decision = shouldSummarizeToolResult(rawResultText, invocation.modelId, toolCompaction);

        if (!decision.shouldSummarize) {
          summarizedByToolCallId.set(toolCallId, false);
          return rawResult;
        }

        console.info('[chat] tool compaction decision', {
          toolName,
          toolCallId,
          mode: decision.mode,
          tokenCount: decision.tokenCount,
          threshold: decision.threshold,
          shouldCompact: decision.shouldSummarize,
        });

        if (decision.mode === 'summary') {
          emitToolState(toolCallId, toolName, 'summarizing');
        }

        const summarized = await maybeSummarizeToolResult(
          toolName,
          rawResultText,
          invocation,
          userQuery,
          toolCompaction,
          effectiveSystemPrompts,
          auxiliaryMemory,
        );
        summarizedByToolCallId.set(toolCallId, summarized.wasSummarized);
        console.info('[chat] tool compaction result', {
          toolName,
          toolCallId,
          mode: decision.mode,
          wasCompacted: summarized.wasSummarized,
          originalTokens: summarized.originalTokens,
          compactedTokens: summarized.summaryTokens,
          tokensFreed: summarized.tokensFreed,
        });

        return summarized.wasSummarized ? summarized.text : rawResult;
      },
    });
  }

  wrapped[SUB_AGENT_TOOL_NAME] = createTool({
    id: SUB_AGENT_TOOL_NAME,
    description:
      'Launches multiple parallel sub-agents (recursive model calls) to investigate different tasks and returns all results for synthesis. Each agent task must be fully self-contained because sub-agents only receive the objective/task text passed to this tool.',
    inputSchema: LaunchSubAgentsInputSchema,
    execute: async ({ objective, agents }, context) => {
      if (recursionContext.depth >= recursionContext.maxDepth) {
        return {
          ok: false,
          error: `Sub-agent recursion depth limit reached (${recursionContext.maxDepth}).`,
        };
      }

      const toolCallId =
        typeof (context as { toolCallId?: unknown } | undefined)?.toolCallId === 'string'
          ? ((context as { toolCallId: string }).toolCallId)
          : `${SUB_AGENT_TOOL_NAME}-${Date.now()}`;

      const runDepth = recursionContext.depth + 1;
      const runId = `${toolCallId}-${crypto.randomUUID().slice(0, 8)}`;
      const normalizedAgents = (agents as LaunchSubAgentsInput['agents']).map((agent, index: number) => {
        const fallbackLabel = `Agent ${index + 1}`;
        const trimmedLabel = (agent.label ?? '').trim();
        return {
          id: (agent.id ?? '').trim() || `${runId}-agent-${index + 1}`,
          label: trimmedLabel || fallbackLabel,
          task: agent.task.trim(),
        };
      }).filter((agent) => agent.task.length > 0);

      if (normalizedAgents.length === 0) {
        return { ok: false, error: 'No valid sub-agent tasks provided.' };
      }

      const totalAgents = normalizedAgents.length;
      let completedAgents = 0;

      for (const agent of normalizedAgents) {
        emitSubAgentState({
          runId,
          toolCallId,
          toolName: SUB_AGENT_TOOL_NAME,
          objective,
          depth: runDepth,
          parentRunId: recursionContext.parentRunId,
          parentAgentId: recursionContext.parentAgentId,
          parentAgentLabel: recursionContext.parentAgentLabel,
          totalAgents,
          completedAgents,
          agentId: agent.id,
          label: agent.label,
          task: agent.task,
          state: 'queued',
          progress: 'Queued',
        });
      }

      const results = await Promise.all(normalizedAgents.map(async (agent, index: number) => {
        const startedAt = Date.now();
        emitSubAgentState({
          runId,
          toolCallId,
          toolName: SUB_AGENT_TOOL_NAME,
          objective,
          depth: runDepth,
          parentRunId: recursionContext.parentRunId,
          parentAgentId: recursionContext.parentAgentId,
          parentAgentLabel: recursionContext.parentAgentLabel,
          totalAgents,
          completedAgents,
          agentId: agent.id,
          label: agent.label,
          task: agent.task,
          state: 'running',
          startedAt,
          progress: 'Running recursive investigation',
        });

        try {
          const systemPromptsForSubAgent = composeSubAgentSystemPrompts(
            rootSystemPrompts,
            objective,
            agent.label,
            index + 1,
            totalAgents,
          );
          const system = joinSystemPrompts(systemPromptsForSubAgent);
          const summarizedByNestedToolCallId = new Map<string, boolean>();
          const nestedTools = wrapToolsForModelThread(
            tools,
            invocation,
            toolCompaction,
            systemPromptsForSubAgent,
            rootSystemPrompts,
            agent.task,
            emitToolState,
            emitSubAgentState,
            agentExecution,
            summarizedByNestedToolCallId,
            abortSignal,
            auxiliaryMemory,
            {
              depth: runDepth,
              maxDepth: recursionContext.maxDepth,
              parentRunId: runId,
              parentAgentId: agent.id,
              parentAgentLabel: agent.label,
            },
            { enabled: false },
          );

          const subAgentModel = await createMastraAgentWithMemory({
            id: `sub-agent-${invocation.modelId}`,
            name: 'Recursive Sub Agent',
            instructions: system,
            model: invocation.model,
            tools: nestedTools as never,
          }, auxiliaryMemory);
          const subAgentResult = await subAgentModel.stream([
            { role: 'user', content: agent.task },
          ], {
            memory: toMastraMemoryOption(auxiliaryMemory),
            providerOptions: getProviderOptionsForCall(invocation, system),
            maxSteps: agentExecution.maxSubAgentSteps,
            abortSignal,
            timeout: resolveMastraModelTimeout(),
            onChunk: async (chunk: Record<string, unknown>) => {
              const chunkType = getMastraPartType(chunk as MastraTextStreamPart);
              if (chunkType === 'tool-input-start') {
                emitToolState(readToolCallId(chunk), readToolName(chunk), 'pending');
              } else if (chunkType === 'tool-call') {
                emitToolState(readToolCallId(chunk), readToolName(chunk), 'running');
              }
            },
            onStepFinish: async (step: { toolCalls?: unknown[]; toolResults?: unknown[] }) => {
              const { toolCalls, toolResults } = step;
              if (!toolCalls || !toolResults) {
                return;
              }
              for (let i = 0; i < toolCalls.length; i += 1) {
                const tc = toolCalls[i] as unknown as Record<string, unknown> | undefined;
                const tr = toolResults[i] as unknown as Record<string, unknown> | undefined;
                if (!tc || !tr) {
                  continue;
                }
                const toolOutput = readToolResultOutput(tr);
                const resultStr = stringifyToolResult(toolOutput);
                const resultObj = toolOutput as { error?: unknown } | undefined;
                const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined;
                const inferredError = resultStr.toLowerCase().includes('error executing tool')
                  ? resultStr
                  : undefined;
                const toolError = explicitError ?? inferredError;
                const nestedToolCallId = readToolCallId(tc);
                const nestedToolName = readToolName(tc);
                emitToolState(nestedToolCallId, nestedToolName, toolError ? 'error' : 'done', {
                  resultSummarized: summarizedByNestedToolCallId.get(nestedToolCallId) ?? false,
                  error: toolError,
                });
              }
            },
          } as never);
          const [rawText, steps, finishReason] = await Promise.all([
            subAgentResult.text,
            subAgentResult.steps,
            subAgentResult.finishReason,
          ]);
          const trimmedText = rawText.trim();
          const toolSummary = summarizeSubAgentToolResults(
            steps as unknown as Array<{ toolResults?: Array<{ toolName: string; output: unknown }> }>,
          );
          const resultText = trimmedText
            || (
              toolSummary
                ? `The sub-agent completed through tool calls without direct narrative output.\n\nTool Results:\n${toolSummary}`
                : `The sub-agent completed without direct text output (finish reason: ${finishReason}).`
            );
          completedAgents += 1;
          emitSubAgentState({
            runId,
            toolCallId,
            toolName: SUB_AGENT_TOOL_NAME,
            objective,
            depth: runDepth,
            parentRunId: recursionContext.parentRunId,
            parentAgentId: recursionContext.parentAgentId,
            parentAgentLabel: recursionContext.parentAgentLabel,
            totalAgents,
            completedAgents,
            agentId: agent.id,
            label: agent.label,
            task: agent.task,
            state: 'done',
            startedAt,
            finishedAt: Date.now(),
            progress: 'Completed',
            result: truncateText(resultText || '(No output)', SUB_AGENT_RESULT_PREVIEW_MAX_CHARS),
          });
          return {
            id: agent.id,
            label: agent.label,
            task: agent.task,
            status: 'done' as const,
            result: resultText,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          completedAgents += 1;
          emitSubAgentState({
            runId,
            toolCallId,
            toolName: SUB_AGENT_TOOL_NAME,
            objective,
            depth: runDepth,
            parentRunId: recursionContext.parentRunId,
            parentAgentId: recursionContext.parentAgentId,
            parentAgentLabel: recursionContext.parentAgentLabel,
            totalAgents,
            completedAgents,
            agentId: agent.id,
            label: agent.label,
            task: agent.task,
            state: 'error',
            startedAt,
            finishedAt: Date.now(),
            progress: 'Failed',
            error: message,
          });
          return {
            id: agent.id,
            label: agent.label,
            task: agent.task,
            status: 'error' as const,
            error: message,
          };
        }
      }));

      return {
        ok: true,
        runId,
        objective,
        depth: runDepth,
        parentRunId: recursionContext.parentRunId,
        parentAgentId: recursionContext.parentAgentId,
        parentAgentLabel: recursionContext.parentAgentLabel,
        totalAgents,
        completedAgents,
        results,
      };
    },
  });

  if (locationRequestContext?.enabled && recursionContext.depth === 0) {
    wrapped[REQUEST_USERS_LOCATION_TOOL_NAME] = createTool({
      id: REQUEST_USERS_LOCATION_TOOL_NAME,
      description:
        'Pauses the current turn and asks the client to collect browser geolocation on demand. Use this only when exact device location or timezone context is required to answer accurately.',
      inputSchema: RequestUsersLocationInputSchema,
      execute: async ({ reason }: RequestUsersLocationInput) => {
        const pendingRequest = createPendingLocationRequest({
          resourceId: locationRequestContext.resourceId,
          ...(locationRequestContext.conversationId ? { conversationId: locationRequestContext.conversationId } : {}),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          resumeLabel: 'Share location',
          emitAnnotation: locationRequestContext.emitAnnotation,
        });
        locationRequestContext.emitAnnotation?.(pendingRequest.annotation);

        const handleAbort = () => {
          pendingRequest.cancel('Location request cancelled because the chat request ended.');
        };
        if (abortSignal.aborted) {
          handleAbort();
        } else {
          abortSignal.addEventListener('abort', handleAbort, { once: true });
        }

        try {
          const resolution = await pendingRequest.waitForResolution();
          if (resolution.status === 'saved') {
            return {
              ok: true,
              status: 'saved',
              requestId: resolution.requestId,
              message: resolution.message ?? 'Browser location saved to working memory.',
              location: resolution.location ?? null,
            };
          }
          if (resolution.status === 'timed-out') {
            return {
              ok: false,
              status: 'timed-out',
              requestId: resolution.requestId,
              error: resolution.message ?? 'Location request timed out after 5 minutes.',
            };
          }
          return {
            ok: false,
            status: resolution.status,
            requestId: resolution.requestId,
            message: resolution.message ?? 'Location was not provided.',
          };
        } finally {
          abortSignal.removeEventListener('abort', handleAbort);
        }
      },
    });
  }

  return wrapped as Awaited<ReturnType<typeof getChatTools>>;
}

export async function POST(request: Request) {
  try {
    if (request.signal.aborted) {
      return new Response(null, { status: 499, statusText: 'Client Closed Request' });
    }

    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const {
      messages,
      model,
      profileId,
      useAutoRouting,
      autoActivityId,
      systemPrompt,
      conversationId,
      locationResume,
    } = parsed.data;
    const coreMessages = await toModelMessages(messages as unknown as Array<Record<string, unknown>>);
    const config = await readConfig();
    const resourceId = resolveAuthenticatedResourceId();
    let chatThreadId: string;
    let auxiliaryMemory: MastraCallMemory;
    try {
      chatThreadId = resolveChatThreadId(config, conversationId);
      auxiliaryMemory = buildAuxiliaryMemoryCall({
        threadId: chatThreadId,
        resourceId,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Invalid memory scope request' },
        { status: 400 },
      );
    }
    const contextManagement = config.contextManagement;
    const toolCompaction = config.toolCompaction;
    const agentExecution = config.agentExecution;
    const chatTools = await getChatTools();
    const toolMetadata = await getToolMetadata();

    // Handle command-style messages without LLM call
    const cmd = parseCommand(extractLatestUserText(coreMessages));
    if (cmd && conversationId) {
      if (cmd.kind === 'profile') {
        const profile = getProfileById(config, cmd.profileId);
        if (!profile || !profile.enabled) {
          return jsonMessage(`Profile not found or disabled: ${cmd.profileId}`);
        }
        const primaryTarget = getPrimaryRouteTarget(config);
        const existingState = config.conversations[conversationId];
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: profile.allowedModels[0] ?? primaryTarget.modelId,
          autoActivityId: existingState?.autoActivityId ?? config.routing.defaultActivityProfileId,
        };
        await writeConfig(config);
        return jsonMessage(`Switched profile to ${profile.id}`);
      }

      if (cmd.kind === 'model') {
        const state = config.conversations[conversationId];
        const baseProfileId = state?.activeProfileId ?? getPrimaryRouteTarget(config).profileId;
        const profile = getProfileById(config, baseProfileId);
        if (!profile) {
          return jsonMessage('No active profile for this conversation.');
        }
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: cmd.modelId,
          autoActivityId: state?.autoActivityId ?? config.routing.defaultActivityProfileId,
        };
        await writeConfig(config);
        return jsonMessage(`Switched model to ${cmd.modelId}`);
      }

      if (cmd.kind === 'route-primary') {
        const profile = getProfileById(config, cmd.profileId);
        if (!profile) {
          return jsonMessage(`Profile not found: ${cmd.profileId}`);
        }
        const newEntry = { profileId: cmd.profileId, modelId: cmd.modelId };
        const defaultIdx = config.routing.activityProfiles.findIndex(
          (activity) => activity.id === config.routing.defaultActivityProfileId,
        );
        const activityIdx = defaultIdx >= 0 ? defaultIdx : 0;
        const activity = config.routing.activityProfiles[activityIdx];
        if (!activity) {
          return jsonMessage('No auto activity profiles are configured.');
        }
        const nextPriority = [
          newEntry,
          ...activity.modelPriority.filter((t) => !(t.profileId === newEntry.profileId && t.modelId === newEntry.modelId)),
        ];
        config.routing.activityProfiles[activityIdx] = {
          ...activity,
          modelPriority: nextPriority,
        };
        await writeConfig(config);
        return jsonMessage(`Updated primary route to ${cmd.profileId} / ${cmd.modelId}`);
      }
    }

    // Determine route targets.
    const convoState = conversationId ? config.conversations[conversationId] : undefined;
    const globalPrimary = getPrimaryRouteTarget(config);
    const autoMode = useAutoRouting ?? false;
    const hasRequestedActivityId = typeof autoActivityId === 'string' && autoActivityId.trim().length > 0;
    let selectedAutoActivityId = config.routing.defaultActivityProfileId;
    let autoTargets: RouteTarget[] = [];
    try {
      const resolvedAutoActivity = resolveAutoActivityProfile(config, {
        requestedActivityId: autoActivityId,
        conversationActivityId: convoState?.autoActivityId,
        strictRequested: hasRequestedActivityId,
      });
      selectedAutoActivityId = resolvedAutoActivity.id;
      autoTargets = getAutoTargetsForActivity(config, {
        requestedActivityId: autoActivityId,
        conversationActivityId: convoState?.autoActivityId,
        strictRequested: hasRequestedActivityId,
      }).targets;
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Invalid auto activity' },
        { status: 400 },
      );
    }
    const primaryTarget: RouteTarget = {
      profileId: profileId ?? convoState?.activeProfileId ?? globalPrimary.profileId,
      modelId: model ?? convoState?.activeModelId ?? globalPrimary.modelId,
    };

    const routeFailures: Array<{ profileId: string; modelId: string; error: string }> = [];
    let activeAttemptController: AbortController | null = null;

    // Keep provider calls in sync with client lifecycle (Stop button / disconnect).
    const abortActiveAttemptFromClient = () => {
      if (!activeAttemptController || activeAttemptController.signal.aborted) {
        return;
      }
      activeAttemptController.abort(request.signal.reason);
      console.info('[chat] client aborted request; canceled active upstream stream');
    };
    request.signal.addEventListener('abort', abortActiveAttemptFromClient, { once: true });

    const maxAttempts = Math.max(1, config.routing.maxAttempts);
    const attempts = autoMode ? autoTargets.slice(0, maxAttempts) : [primaryTarget];
    if (autoMode && attempts.length === 0) {
      return Response.json(
        { error: `No models configured for auto activity "${selectedAutoActivityId}"` },
        { status: 400 },
      );
    }

    // Cache compaction per effective route+system so retries with identical settings
    // do not repeat expensive summarization work.
    const compactionCache = new Map<string, Awaited<ReturnType<typeof maybeCompact>>>();
    const latestUserQuery = extractLatestUserText(coreMessages);

    for (let idx = 0; idx < attempts.length; idx += 1) {
      if (request.signal.aborted) {
        return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      }
      const target = attempts[idx];
      const attemptStart = Date.now();
      console.warn(`[chat] route attempt ${idx + 1}/${attempts.length}`, target);

      // Create a per-attempt AbortController so we can cancel orphaned streams
      const attemptController = new AbortController();
      activeAttemptController = attemptController;
      const pendingAnnotations: StreamAnnotation[] = [];
      const annotationSource = createStreamingAnnotationSource();
      let annotationStreamingActive = false;

      try {
        const resolved = await getLanguageModelForProfile(target.profileId, target.modelId);
        const chosenTarget = { profileId: resolved.profile.id, modelId: resolved.modelId };
        const chosenProfile = resolved.profile;

        const requestSystemPrompt = systemPrompt?.trim();
        const locationResumeSystemPrompt = createLocationResumeSystemPrompt(locationResume);
        const baseSystemPrompts = composeSystemPrompts(chosenProfile);
        const modelBehavior = resolveModelBehavior(config.modelBehavior, chosenTarget.modelId);
        const systemPrompts = mergeSystemPromptLists(
          baseSystemPrompts,
          modelBehavior.additionalSystemPrompts,
          locationResumeSystemPrompt ? [locationResumeSystemPrompt] : [],
          requestSystemPrompt ? [requestSystemPrompt] : [],
        );
        if (systemPrompts.length === 0) {
          systemPrompts.push(DEFAULT_SYSTEM);
        }
        const effectiveSystem = joinSystemPrompts(systemPrompts);
        const invocation: ModelInvocationContext = {
          model: resolved.model,
          provider: chosenProfile.provider,
          modelId: chosenTarget.modelId,
        };
        const { memory: primaryMemory, semanticRecallStatus } = await buildScopedPrimaryMemoryCall({
          config,
          threadId: chatThreadId,
          activeProfileId: chosenTarget.profileId,
          activeModelId: chosenTarget.modelId,
          compactionMode: contextManagement.mode,
        });
        console.info('[chat] semantic recall', {
          state: semanticRecallStatus.state,
          reason: semanticRecallStatus.reason,
          profileId: semanticRecallStatus.profileId ?? null,
          modelId: semanticRecallStatus.modelId ?? null,
        });

        const compactionKey = `${chosenTarget.profileId}:${chosenTarget.modelId}:${effectiveSystem}`;
        let compacted = compactionCache.get(compactionKey);
        if (!compacted) {
          compacted = await maybeCompact(
            coreMessages,
            invocation,
            systemPrompts,
            chosenTarget.modelId,
            contextManagement,
            auxiliaryMemory,
          );
          compactionCache.set(compactionKey, compacted);
        }
        console.info('[chat] context compaction check', {
          profileId: chosenTarget.profileId,
          modelId: chosenTarget.modelId,
          configuredMode: contextManagement.mode,
          threshold: contextManagement.compactionThreshold,
          targetRatio: contextManagement.targetContextRatio,
          used: compacted.stats.used,
          limit: compacted.stats.limit,
          usageRatio: Number(compacted.stats.percentage.toFixed(4)),
          shouldCompact: compacted.stats.shouldCompact,
          wasCompacted: compacted.wasCompacted,
          compactionMode: compacted.compactionMode ?? null,
          tokensFreed: compacted.tokensFreed,
        });

        const summarizedByToolCallId = new Map<string, boolean>();
        const lastToolState = new Map<string, string>();

        const emitAnnotation = (annotation: StreamAnnotation) => {
          if (annotationStreamingActive) {
            annotationSource.emit(annotation);
            return;
          }
          pendingAnnotations.push(annotation);
        };

        const emitToolState = (
          toolCallId: string,
          toolName: string,
          state: Extract<StreamAnnotation, { type: 'tool-state' }>['state'],
          extra?: Partial<Omit<Extract<StreamAnnotation, { type: 'tool-state' }>, 'type' | 'toolCallId' | 'toolName' | 'state'>>,
        ) => {
          const stateKey = `${state}:${extra?.resultSummarized ?? ''}:${extra?.error ?? ''}`;
          if (lastToolState.get(toolCallId) === stateKey) {
            return;
          }
          lastToolState.set(toolCallId, stateKey);

          emitAnnotation({
            type: 'tool-state',
            toolCallId,
            toolName,
            state,
            icon: toolMetadata[toolName]?.icon ?? INTERNAL_TOOL_ICONS[toolName],
            ...extra,
          });
        };

        const emitSubAgentState = (
          annotation: Omit<Extract<StreamAnnotation, { type: 'sub-agent-state' }>, 'type'>,
        ) => {
          emitAnnotation({
            type: 'sub-agent-state',
            ...annotation,
          });
        };

        emitAnnotation({
          type: 'context-stats',
          used: compacted.stats.used,
          limit: compacted.stats.limit,
          percentage: compacted.stats.percentage,
          wasCompacted: compacted.wasCompacted,
          compactionMode: compacted.compactionMode,
          tokensFreed: compacted.tokensFreed,
        });
        if (compacted.wasCompacted) {
          emitAnnotation({
            type: 'context-compacted',
            messages: toCompactedAnnotationMessages(compacted.messages),
          });
        }
        emitAnnotation({
          type: 'route-attempt',
          attempt: idx + 1,
          profileId: chosenTarget.profileId,
          provider: chosenProfile.provider,
          model: chosenTarget.modelId,
          status: 'succeeded',
        });
        if (locationResume) {
          emitAnnotation({
            type: 'location-status',
            requestId: locationResume.requestId,
            status: locationResume.status,
            ...(locationResume.message?.trim() ? { message: locationResume.message.trim() } : {}),
            ...(conversationId ? { conversationId } : {}),
          });
        }

        if (conversationId) {
          await upsertConversationRoute(conversationId, {
            activeProfileId: chosenTarget.profileId,
            activeModelId: chosenTarget.modelId,
            autoActivityId: autoMode
              ? selectedAutoActivityId
              : (convoState?.autoActivityId ?? config.routing.defaultActivityProfileId),
          });
        }

        const providerOptions = getProviderOptionsForCall(invocation, effectiveSystem);
        const toolsForAttempt = wrapToolsForModelThread(
          chatTools,
          invocation,
          toolCompaction,
          systemPrompts,
          systemPrompts,
          latestUserQuery,
          emitToolState,
          emitSubAgentState,
          agentExecution,
          summarizedByToolCallId,
          attemptController.signal,
          auxiliaryMemory,
          { depth: 0, maxDepth: SUB_AGENT_MAX_DEPTH },
          {
            enabled: true,
            resourceId,
            conversationId,
            emitAnnotation,
          },
        );
        const chatAgent = await createMastraAgentWithMemory({
          id: `chat-${chosenTarget.profileId}-${chosenTarget.modelId}`,
          name: 'Chat Agent',
          instructions: effectiveSystem,
          model: resolved.model,
          tools: toolsForAttempt as never,
        }, primaryMemory);
        const result = await chatAgent.stream(compacted.messages as never, {
          memory: toMastraMemoryOption(primaryMemory),
          providerOptions,
          modelSettings: {
            ...(modelBehavior.sampling.temperature !== undefined
              ? { temperature: modelBehavior.sampling.temperature }
              : {}),
            ...(modelBehavior.sampling.topP !== undefined
              ? { topP: modelBehavior.sampling.topP }
              : {}),
            ...(modelBehavior.sampling.topK !== undefined
              ? { topK: modelBehavior.sampling.topK }
              : {}),
          },
          maxSteps: agentExecution.maxSteps,
          abortSignal: attemptController.signal,
          timeout: resolveMastraModelTimeout(),
          onChunk: async (chunk: Record<string, unknown>) => {
            const chunkType = getMastraPartType(chunk as MastraTextStreamPart);
            if (chunkType === 'tool-input-start') {
              emitToolState(readToolCallId(chunk), readToolName(chunk), 'pending');
            } else if (chunkType === 'tool-call') {
              emitToolState(readToolCallId(chunk), readToolName(chunk), 'running');
            }
          },
          onStepFinish: async (step: { toolCalls?: unknown[]; toolResults?: unknown[] }) => {
            const { toolCalls, toolResults } = step;
            if (!toolCalls || !toolResults) {
              return;
            }
            for (let i = 0; i < toolCalls.length; i += 1) {
              const tc = toolCalls[i] as unknown as Record<string, unknown> | undefined;
              const tr = toolResults[i] as unknown as Record<string, unknown> | undefined;
              if (!tc || !tr) {
                continue;
              }
              const toolOutput = readToolResultOutput(tr);
              const resultStr = stringifyToolResult(toolOutput);
              const resultObj = toolOutput as { error?: unknown } | undefined;
              const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined;
              const inferredError = resultStr.toLowerCase().includes('error executing tool')
                ? resultStr
                : undefined;
              const toolError = explicitError ?? inferredError;
              const attemptToolCallId = readToolCallId(tc);
              const attemptToolName = readToolName(tc);
              emitToolState(attemptToolCallId, attemptToolName, toolError ? 'error' : 'done', {
                resultSummarized: summarizedByToolCallId.get(attemptToolCallId) ?? false,
                error: toolError,
              });
            }
          },
        } as never);

        let streamParts: AsyncIterable<MastraTextStreamPart> = result.fullStream as AsyncIterable<MastraTextStreamPart>;
        if (autoMode) {
          const probed = await probeMastraStream(streamParts, {
            abortSignal: attemptController.signal,
            startupTimeoutMs: 10_000,
          });
          streamParts = {
            async *[Symbol.asyncIterator]() {
              yield probed.firstPart;
              for await (const part of probed.rest) {
                yield part;
              }
            },
          };
        }

        const headers = new Headers({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Context-Used': String(compacted.stats.used),
          'X-Context-Limit': String(compacted.stats.limit),
          'X-Was-Compacted': String(compacted.wasCompacted),
          'X-Compaction-Configured-Mode': contextManagement.mode,
          'X-Compaction-Threshold': String(contextManagement.compactionThreshold),
          ...(compacted.compactionMode ? { 'X-Compaction-Mode': compacted.compactionMode } : {}),
          ...(compacted.tokensFreed > 0 ? { 'X-Compaction-Tokens-Freed': String(compacted.tokensFreed) } : {}),
          'X-Active-Profile': chosenTarget.profileId,
          'X-Active-Model': chosenTarget.modelId,
          'X-Auto-Activity-Id': selectedAutoActivityId,
          'X-Semantic-Recall-State': semanticRecallStatus.state,
          'X-Semantic-Recall-Reason': encodeURIComponent(semanticRecallStatus.reason),
          'X-Route-Fallback': String(routeFailures.length > 0),
          ...(routeFailures.length > 0
            ? { 'X-Route-Failures': encodeURIComponent(JSON.stringify(routeFailures.slice(0, 3))) }
            : {}),
        });

        annotationStreamingActive = true;
        return new Response(createChatEventStreamFromMastra({
          stream: streamParts,
          annotations: pendingAnnotations,
          annotationStream: annotationSource.stream,
          onCloseAnnotations: annotationSource.close,
        }), { headers });
      } catch (err) {
        attemptController.abort();
        annotationSource.close();
        if (isLocationRequestInterruptError(err)) {
          return new Response(createChatEventStreamFromMastra({
            stream: {
              [Symbol.asyncIterator]() {
                return {
                  next: async () => ({ done: true as const, value: undefined }),
                };
              },
            },
            annotations: err.annotation ? [err.annotation] : [],
          }), {
            headers: new Headers({
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            }),
          });
        }
        const elapsed = Date.now() - attemptStart;
        const msg = err instanceof Error ? err.message : String(err);
        if (request.signal.aborted) {
          console.info(`[chat] route attempt ${idx + 1} canceled by client (${elapsed}ms)`, target);
          return new Response(null, { status: 499, statusText: 'Client Closed Request' });
        }
        routeFailures.push({ profileId: target.profileId, modelId: target.modelId, error: msg });
        console.warn(`[chat] route attempt ${idx + 1} failed (${elapsed}ms)`, target, err);
      }
    }

    return Response.json({ error: 'All route attempts failed. Check profile credentials/models.', routeFailures }, { status: 500 });
  } catch (error) {
    console.error('[chat] fatal error', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  const config = await readConfig();
  const stats = getContextStats([], DEFAULT_SYSTEM, undefined, config.contextManagement);
  const primary = getPrimaryRouteTarget(config);
  return Response.json({
    models: getModelOptions(),
    profiles: config.profiles.filter((p) => p.enabled).map((p) => ({
      id: p.id,
      provider: p.provider,
      displayName: p.displayName,
      allowedModels: p.allowedModels,
    })),
    routing: {
      primary: primary ?? { profileId: '', modelId: '' },
      activityProfiles: config.routing.activityProfiles,
      defaultActivityProfileId: config.routing.defaultActivityProfileId,
      maxAttempts: config.routing.maxAttempts,
    },
    contextManagement: config.contextManagement,
    contextLimit: stats.limit,
  });
}
