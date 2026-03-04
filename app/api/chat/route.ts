/* eslint-disable max-len */
import { streamText, tool, type ModelMessage, type UIMessage, stepCountIs, createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter, convertToModelMessages } from 'ai';
import { maybeCompact, getContextStats } from '@/lib/ai/context-manager';
import { maybeSummarizeToolResult, shouldSummarizeToolResult } from '@/lib/ai/summarizer';
import { getChatTools, getToolMetadata } from '@/lib/ai/tools';
import type { StreamAnnotation } from '@/lib/types';
import { z } from 'zod/v3';

const textDecoder = new TextDecoder();
import { readConfig, writeConfig, getProfileById, composeSystemPrompts, upsertConversationRoute, type RouteTarget } from '@/lib/config/store';
import { getLanguageModelForProfile, getModelOptions, getProviderOptionsForCall, type ModelInvocationContext } from '@/lib/ai/providers';
import type { ToolCompactionPolicy } from '@/lib/config/store';

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
  systemPrompt: z.string().optional(),
  conversationId: z.string().optional(),
});

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant with access to several tools.

You can:
- Search the web for current information
- Perform calculations
- Run JavaScript code
- Read uploaded files
- Check the current date and time
- Launch parallel sub-agents to investigate multiple threads at once when the task benefits from it
- When launching sub-agents, include all required context, constraints, and success criteria in each agent task because sub-agents only see what you pass in the tool input

When using tools, explain what you're doing. When you receive tool results, synthesize them clearly.
If the user asks for a code example, snippet, template, or "what the code would look like", DO NOT run tools or execute code. Return the example directly.
Only execute code/commands when the user clearly asks you to run, test, or verify execution.
If execution intent is ambiguous, ask a brief clarifying question before running anything.
Be concise but thorough. Use markdown formatting for structure.`;

const SUB_AGENT_TOOL_NAME = 'launch_sub_agents';
const SUB_AGENT_RESULT_PREVIEW_MAX_CHARS = 3000;
const SUB_AGENT_MAX_DEPTH = 4;
const EXECUTION_TOOL_NAMES = new Set([
  'codeRunner',
  'run_command',
  'tool_builder',
  'tool_editor',
  'file_write',
]);
const INTERNAL_TOOL_ICONS: Record<string, string> = {
  [SUB_AGENT_TOOL_NAME]: '🧵',
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

/**
 * Converts incoming request messages to ModelMessage[] for streamText.
 * Handles v5 parts-based messages (from DefaultChatTransport sendMessage)
 * and legacy content-based messages (from command handler).
 */
async function toModelMessages(messages: Array<Record<string, unknown>>): Promise<ModelMessage[]> {
  // If messages have parts, they're in v5 UIMessage format — use convertToModelMessages
  const hasPartsFormat = messages.some((m) => Array.isArray(m.parts));
  if (hasPartsFormat) {
    // Ensure all messages have parts (wrap legacy content-only messages)
    // and strip UI-only data-* annotation parts that the model should never see.
    const normalized = messages.map((m) => {
      if (Array.isArray(m.parts)) {
        const modelParts = (m.parts as Array<Record<string, unknown>>).filter(
          (p) => typeof p.type !== 'string' || !p.type.startsWith('data-'),
        );
        return { ...m, parts: modelParts };
      }
      return { ...m, parts: [{ type: 'text', text: String(m.content ?? '') }] };
    });
    return convertToModelMessages(normalized as unknown as UIMessage[]);
  }

  // Legacy path: content-only or content + experimental_attachments (v4 format)
  return messages.map((m) => {
    const attachments = m.experimental_attachments as Array<{ url: string; contentType?: string }> | undefined;
    if (m.role !== 'user' || !attachments?.length) {
      return m as unknown as ModelMessage;
    }
    const parts: Array<Record<string, unknown>> = [];
    if (typeof m.content === 'string' && (m.content as string).trim()) {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      parts.push(...(m.content as Array<Record<string, unknown>>));
    }
    for (const a of attachments) {
      if (a.contentType?.startsWith('image/')) {
        parts.push({ type: 'image', image: a.url });
      }
    }
    return { role: m.role, content: parts.length > 0 ? parts : m.content } as ModelMessage;
  });
}

function extractLatestUserText(messages: Array<Record<string, unknown> | ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role !== 'user') {
      continue;
    }
    // v5: extract text from parts
    if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: unknown) => (p as Record<string, unknown>)?.type === 'text');
      return textPart ? String((textPart as Record<string, unknown>).text ?? '').trim() : '';
    }
    // Legacy: content string
    if (typeof msg.content === 'string') {
      return msg.content.trim();
    }
    return '';
  }
  return '';
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

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... (truncated ${value.length - maxChars} chars)`;
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
  recursionContext: SubAgentRecursionContext,
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

    wrapped[toolName] = {
      ...(toolDef as Record<string, unknown>),
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
    };
  }

  wrapped[SUB_AGENT_TOOL_NAME] = tool({
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
      const normalizedAgents = agents.map((agent, index) => {
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

      const results = await Promise.all(normalizedAgents.map(async (agent, index) => {
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
            {
              depth: runDepth,
              maxDepth: recursionContext.maxDepth,
              parentRunId: runId,
              parentAgentId: agent.id,
              parentAgentLabel: agent.label,
            },
          );

          const subAgentResult = streamText({
            model: invocation.model,
            maxRetries: 0,
            providerOptions: getProviderOptionsForCall(invocation, system),
            messages: [
              ...systemPromptsForSubAgent.map((content) => ({ role: 'system' as const, content })),
              { role: 'user', content: agent.task },
            ],
            tools: nestedTools,
            stopWhen: stepCountIs(agentExecution.maxSubAgentSteps),
            abortSignal,
            onChunk: async ({ chunk }) => {
              if (chunk.type === 'tool-input-start') {
                emitToolState(chunk.id, chunk.toolName, 'pending');
              } else if (chunk.type === 'tool-call') {
                emitToolState(chunk.toolCallId, chunk.toolName, 'running');
              }
            },
            onStepFinish: async ({ toolCalls, toolResults }) => {
              if (!toolCalls || !toolResults) {
                return;
              }
              for (let i = 0; i < toolCalls.length; i += 1) {
                const tc = toolCalls[i];
                const tr = toolResults[i];
                if (!tc || !tr) {
                  continue;
                }
                const resultStr = stringifyToolResult(tr.output);
                const resultObj = tr.output as { error?: unknown } | undefined;
                const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined;
                const inferredError = resultStr.toLowerCase().includes('error executing tool')
                  ? resultStr
                  : undefined;
                const toolError = explicitError ?? inferredError;
                emitToolState(tc.toolCallId, tc.toolName, toolError ? 'error' : 'done', {
                  resultSummarized: summarizedByNestedToolCallId.get(tc.toolCallId) ?? false,
                  error: toolError,
                });
              }
            },
          });
          const [rawText, steps, finishReason] = await Promise.all([
            subAgentResult.text,
            subAgentResult.steps,
            subAgentResult.finishReason,
          ]);
          const trimmedText = rawText.trim();
          const toolSummary = summarizeSubAgentToolResults(
            steps as Array<{ toolResults?: Array<{ toolName: string; output: unknown }> }>,
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

    const { messages, model, profileId, useAutoRouting, systemPrompt, conversationId } = parsed.data;
    const coreMessages = await toModelMessages(messages as unknown as Array<Record<string, unknown>>);
    const config = await readConfig();
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
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: profile.allowedModels[0] ?? config.routing.modelPriority[0]?.modelId ?? '',
        };
        await writeConfig(config);
        return jsonMessage(`Switched profile to ${profile.id}`);
      }

      if (cmd.kind === 'model') {
        const state = config.conversations[conversationId];
        const baseProfileId = state?.activeProfileId ?? config.routing.modelPriority[0]?.profileId ?? '';
        const profile = getProfileById(config, baseProfileId);
        if (!profile) {
          return jsonMessage('No active profile for this conversation.');
        }
        config.conversations[conversationId] = {
          activeProfileId: profile.id,
          activeModelId: cmd.modelId,
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
        // Move to front of priority list
        config.routing.modelPriority = [newEntry, ...config.routing.modelPriority.filter((t) => !(t.profileId === newEntry.profileId && t.modelId === newEntry.modelId))];
        await writeConfig(config);
        return jsonMessage(`Updated primary route to ${cmd.profileId} / ${cmd.modelId}`);
      }
    }

    // Determine route targets: per-conversation override > explicit request > global priority list
    const convoState = conversationId ? config.conversations[conversationId] : undefined;
    const globalPrimary = config.routing.modelPriority[0] ?? { profileId: config.profiles[0]?.id ?? '', modelId: '' };
    const autoMode = useAutoRouting ?? false;
    const primaryTarget: RouteTarget = {
      // Auto mode starts from current auto-selected route (client hint),
      // then conversation state, then global priority head.
      profileId: profileId ?? convoState?.activeProfileId ?? globalPrimary.profileId,
      modelId: model ?? convoState?.activeModelId ?? globalPrimary.modelId,
    };

    const targets: RouteTarget[] = [primaryTarget];
    for (const entry of config.routing.modelPriority) {
      if (!targets.some((t) => t.profileId === entry.profileId && t.modelId === entry.modelId)) {
        targets.push(entry);
      }
    }

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
    const attempts = autoMode ? targets.slice(0, maxAttempts) : [primaryTarget];

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
      // Per-attempt buffered data parts (flushed into the stream writer once streaming starts)
      const pendingDataParts: Array<{ type: `data-${string}`; id: string; data: StreamAnnotation }> = [];
      let streamWriter: UIMessageStreamWriter | undefined;

      try {
        const resolved = await getLanguageModelForProfile(target.profileId, target.modelId);
        const chosenTarget = { profileId: resolved.profile.id, modelId: resolved.modelId };
        const chosenProfile = resolved.profile;

        const systemPrompts = composeSystemPrompts(chosenProfile, systemPrompt);
        if (systemPrompts.length === 0) {
          systemPrompts.push(DEFAULT_SYSTEM);
        }
        const effectiveSystem = joinSystemPrompts(systemPrompts);
        const invocation: ModelInvocationContext = {
          model: resolved.model,
          provider: chosenProfile.provider,
          modelId: chosenTarget.modelId,
        };

        const compactionKey = `${chosenTarget.profileId}:${chosenTarget.modelId}:${effectiveSystem}`;
        let compacted = compactionCache.get(compactionKey);
        if (!compacted) {
          compacted = await maybeCompact(coreMessages, invocation, systemPrompts, chosenTarget.modelId, contextManagement);
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
          const part = {
            type: `data-${annotation.type}` as `data-${string}`,
            id: crypto.randomUUID(),
            data: annotation,
            transient: true,
          };
          if (streamWriter) {
            streamWriter.write(part);
          } else {
            pendingDataParts.push(part);
          }
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

        if (conversationId) {
          await upsertConversationRoute(conversationId, {
            activeProfileId: chosenTarget.profileId,
            activeModelId: chosenTarget.modelId,
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
          { depth: 0, maxDepth: SUB_AGENT_MAX_DEPTH },
        );


        const result = streamText({
          model: resolved.model,
          maxRetries: 0,
          messages: [
            ...systemPrompts.map((content) => ({ role: 'system' as const, content })),
            ...compacted.messages,
          ],
          providerOptions,
          tools: toolsForAttempt,
          stopWhen: stepCountIs(agentExecution.maxSteps),
          abortSignal: attemptController.signal,

          onChunk: async ({ chunk }) => {
            if (chunk.type === 'tool-input-start') {
              // v5: tool-input-start uses chunk.id as the toolCallId
              emitToolState(chunk.id, chunk.toolName, 'pending');
            } else if (chunk.type === 'tool-call') {
              emitToolState(chunk.toolCallId, chunk.toolName, 'running');
            }
          },

          onStepFinish: async ({ toolCalls, toolResults }) => {
            if (!toolCalls || !toolResults) {
              return;
            }
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              const tr = toolResults[i];
              if (!tc || !tr) {
                continue;
              }
              const resultStr = stringifyToolResult(tr.output);

              const resultObj = tr.output as { error?: unknown } | undefined;
              const explicitError = typeof resultObj?.error === 'string' ? resultObj.error : undefined;
              const inferredError = resultStr.toLowerCase().includes('error executing tool')
                ? resultStr
                : undefined;
              const toolError = explicitError ?? inferredError;

              emitToolState(tc.toolCallId, tc.toolName, toolError ? 'error' : 'done', {
                resultSummarized: summarizedByToolCallId.get(tc.toolCallId) ?? false,
                error: toolError,
              });
            }
          },
        });

        const formatStreamError = (error: unknown) => {
          const msg = error instanceof Error ? error.message : 'An error occurred';
          const details = error instanceof Error
            ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              cause: String((error as { cause?: unknown }).cause ?? ''),
              raw: JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
            }
            : { raw: String(error) };
          console.error('[chat] stream error', {
            message: msg,
            profileId: chosenTarget.profileId,
            modelId: chosenTarget.modelId,
            provider: chosenProfile.provider,
            details,
          });
          return msg;
        };

        const startupTimeoutMs = 10_000;

        // Build the UI message stream and wrap in a Response synchronously — no need for
        // Promise.race here. The actual startup probe happens below on the stream body.
        const uiStream = createUIMessageStream({
          execute: ({ writer }) => {
            streamWriter = writer;
            // Flush buffered pre-stream annotations (context-stats, route-attempt, etc.)
            for (const part of pendingDataParts) {
              writer.write(part as never);
            }
            pendingDataParts.length = 0;
            writer.merge(result.toUIMessageStream({ onError: formatStreamError }) as unknown as ReadableStream<never>);
          },
          onError: formatStreamError,
        });
        const candidateResponse = createUIMessageStreamResponse({
          stream: uiStream as unknown as ReadableStream<never>,
          headers: {
            'X-Context-Used': String(compacted.stats.used),
            'X-Context-Limit': String(compacted.stats.limit),
            'X-Was-Compacted': String(compacted.wasCompacted),
            'X-Compaction-Configured-Mode': contextManagement.mode,
            'X-Compaction-Threshold': String(contextManagement.compactionThreshold),
            ...(compacted.compactionMode ? { 'X-Compaction-Mode': compacted.compactionMode } : {}),
            ...(compacted.tokensFreed > 0 ? { 'X-Compaction-Tokens-Freed': String(compacted.tokensFreed) } : {}),
            'X-Active-Profile': chosenTarget.profileId,
            'X-Active-Model': chosenTarget.modelId,
            'X-Route-Fallback': String(routeFailures.length > 0),
            ...(routeFailures.length > 0
              ? { 'X-Route-Failures': encodeURIComponent(JSON.stringify(routeFailures.slice(0, 3))) }
              : {}),
          },
        });

        const body = candidateResponse.body;
        if (!body) {
          throw new Error('Empty stream body from provider');
        }

        if (autoMode) {
          // createUIMessageStreamResponse emits SSE format: `data: {"type":"...","..."}\n\n`
          //   Content:   text-delta, text-start, reasoning, reasoning-delta, tool-call, tool-input-delta, tool-input-available
          //   Lifecycle: start, start-step, step-start, stream-start, finish, finish-step, message-metadata, response-metadata
          //   Error:     error, error-json, error-text
          //
          // The probe keeps reading until it sees a genuine content/tool event
          // (success) or an error event (fallback trigger). Lifecycle/metadata
          // events are neutral — keep probing.
          const CONTENT_PREFIXES = /"type"\s*:\s*"(?:text-delta|text-start|reasoning|reasoning-delta|reasoning-start|tool-call|tool-input-delta|tool-input-available|tool-input-start)"/;
          const ERROR_PREFIX = /"type"\s*:\s*"error(?:-json|-text)?"/;

          const [probeBranch, clientBranch] = body.tee();
          const probeReader = probeBranch.getReader();
          try {
            const startupDeadline = Date.now() + startupTimeoutMs;
            let startupBuffer = '';
            let receivedAnyChunk = false;
            let sawContentEvent = false;
            while (Date.now() < startupDeadline) {
              let part: ReadableStreamReadResult<Uint8Array>;
              try {
                const msLeft = Math.max(1, startupDeadline - Date.now());
                part = await Promise.race([
                  probeReader.read(),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('startup read timeout')), msLeft),
                  ),
                ]);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                throw new Error(`Provider stream startup read failed: ${msg}`, { cause: e });
              }

              if (part.done) {
                break;
              }
              if (!part.value) {
                continue;
              }

              const chunkText = textDecoder.decode(part.value);
              if (!chunkText) {
                continue;
              }

              receivedAnyChunk = true;
              startupBuffer = (startupBuffer + chunkText).slice(-4000);
              const lower = startupBuffer.toLowerCase();

              // Check for error prefix or explicit error strings before any content.
              if (
                ERROR_PREFIX.test(startupBuffer) ||
                lower.includes('invalid_api_key') ||
                lower.includes('invalid x-api-key') ||
                lower.includes('authentication') ||
                lower.includes('unauthorized') ||
                lower.includes('forbidden') ||
                lower.includes('bad request') ||
                lower.includes('invalid model') ||
                lower.includes('stream error')
              ) {
                throw new Error(`Provider stream startup failed: ${startupBuffer.slice(-500)}`);
              }

              // A real content/tool event means the provider is working — commit.
              if (CONTENT_PREFIXES.test(startupBuffer)) {
                sawContentEvent = true;
                break;
              }

              // Otherwise it's a lifecycle/metadata-only chunk — keep probing.
            }

            if (!receivedAnyChunk) {
              throw new Error('Provider stream startup timed out before first valid chunk');
            }
            if (!sawContentEvent && receivedAnyChunk) {
              // We got lifecycle/metadata events but never real content before
              // the deadline or stream end. Treat as a startup failure.
              throw new Error(`Provider stream produced no content events within ${startupTimeoutMs}ms: ${startupBuffer.slice(-500)}`);
            }
          } finally {
            // Do not await cancel: some providers keep the stream open and waiting
            // here can block handing the client branch back to the caller.
            void probeReader.cancel().catch(() => {});
          }

          return new Response(clientBranch, {
            status: candidateResponse.status,
            statusText: candidateResponse.statusText,
            headers: candidateResponse.headers,
          });
        }

        return candidateResponse;
      } catch (err) {
        attemptController.abort();
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
  const primary = config.routing.modelPriority[0];
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
      modelPriority: config.routing.modelPriority,
    },
    contextManagement: config.contextManagement,
    contextLimit: stats.limit,
  });
}
