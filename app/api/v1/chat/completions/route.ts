import { readConfig } from '@/lib/config/store';
import { getProviderOptionsForCall } from '@/lib/ai/providers';
import type { LLMProvider } from '@/lib/types';
import { resolveModel } from '../../resolve-model';
import { streamWithFallback, buildAutoTargets } from '@/lib/ai/stream-with-fallback';
import { tool, jsonSchema, type ToolSet } from 'ai';

// ── OpenAI request types ─────────────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function messageContent(content: OpenAIMessage['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/** Convert OpenAI messages array to AI SDK ModelMessage format. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertMessages(messages: OpenAIMessage[]): { system: string | undefined; msgs: any[] } {
  // Build toolCallId → name map from assistant messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  let system: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = (system ? system + '\n\n' : '') + messageContent(msg.content);
    } else if (msg.role === 'user') {
      msgs.push({ role: 'user', content: messageContent(msg.content) });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parts = [];
        const text = messageContent(msg.content);
        if (text) parts.push({ type: 'text', text });
        for (const tc of msg.tool_calls) {
          let input: unknown;
          try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
        }
        msgs.push({ role: 'assistant', content: parts });
      } else {
        msgs.push({ role: 'assistant', content: messageContent(msg.content) });
      }
    } else if (msg.role === 'tool') {
      const toolName = toolNameMap.get(msg.tool_call_id ?? '') ?? '';
      msgs.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id ?? '',
          toolName,
          output: { type: 'text', value: messageContent(msg.content) },
        }],
      });
    }
  }

  return { system, msgs };
}

/** Convert OpenAI tools array to AI SDK ToolSet. */
function buildTools(tools: OpenAITool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    if (t.type === 'function') {
      set[t.function.name] = tool({
        description: t.function.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema((t.function.parameters ?? { type: 'object', properties: {} }) as any),
      });
    }
  }
  return set;
}

/** Convert OpenAI tool_choice to AI SDK toolChoice. */
function convertToolChoice(
  tc: OpenAIToolChoice | undefined,
): string | { type: 'tool'; toolName: string } | undefined {
  if (!tc) return undefined;
  if (tc === 'none') return 'none';
  if (tc === 'auto') return 'auto';
  if (tc === 'required') return 'required';
  if (typeof tc === 'object' && tc.type === 'function') return { type: 'tool', toolName: tc.function.name };
  return undefined;
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const config = await readConfig();

  if (!config.apiEndpoints?.enableOpenAICompat) {
    return Response.json({ error: 'OpenAI-compatible endpoint is disabled' }, { status: 403 });
  }

  const requiredKey = config.apiEndpoints?.endpointApiKey?.trim();
  if (requiredKey) {
    const authHeader = req.headers.get('authorization') ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (provided !== requiredKey) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let body: OpenAIChatRequest;
  try {
    body = (await req.json()) as OpenAIChatRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return Response.json({ error: 'Missing required fields: model, messages' }, { status: 400 });
  }

  // Validate + resolve model — throws with a helpful message on bad input
  let targets: Array<{ profileId: string; modelId: string }>;
  const isAuto = body.model === 'auto';
  try {
    if (isAuto) {
      targets = buildAutoTargets(config.routing.modelPriority);
      if (targets.length === 0) throw new Error('No models configured in routing priority');
    } else {
      const resolved = resolveModel(body.model, config);
      targets = [{ profileId: resolved.profileId, modelId: resolved.resolvedModelId }];
    }
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const { system: systemPrompt, msgs: coreMessages } = convertMessages(body.messages);
  const sdkTools = buildTools(body.tools);
  const sdkToolChoice = convertToolChoice(body.tool_choice);

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  let streamResult: Awaited<ReturnType<typeof streamWithFallback>>;
  try {
    streamResult = await streamWithFallback(
      targets,
      (profileId, modelId) => ({
        messages: coreMessages,
        providerOptions: getProviderOptionsForCall(
          { provider: profileId.split(':').shift() as LLMProvider, modelId },
          systemPrompt ?? '',
        ),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(sdkTools ? { tools: sdkTools } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(sdkToolChoice ? { toolChoice: sdkToolChoice as any } : {}),
      }),
      isAuto ? config.routing.maxAttempts : 1,
    );
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: 'server_error' } },
      { status: 502 },
    );
  }

  const { firstPart, rest, profileId: usedProfileId, failures } = streamResult;

  if (failures.length > 0) {
    console.info('[v1/chat/completions] auto-routing used fallback', { usedProfileId, failures });
  }

  const encoder = new TextEncoder();

  function makeChunk(delta: object, finishReason: string | null) {
    return encoder.encode(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  }

  // Async generator that yields firstPart then all remaining parts
  async function* allParts() {
    yield firstPart;
    for await (const p of rest) yield p;
  }

  if (!body.stream) {
    let text = '';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let finishReason = 'stop';

    for await (const part of allParts()) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'tool-call') {
        toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
      } else if (part.type === 'finish') {
        finishReason = part.finishReason === 'tool-calls' ? 'tool_calls' : 'stop';
      }
    }

    const message: Record<string, unknown> = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }

    return Response.json({
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // Stream mode — process all parts, emit OpenAI SSE chunks
  const stream = new ReadableStream({
    async start(controller) {
      let nextToolIndex = 0;
      // toolCallId → { index, started }
      const toolCallState = new Map<string, { index: number; started: boolean }>();
      let finishReason = 'stop';

      for await (const part of allParts()) {
        if (part.type === 'text-delta') {
          controller.enqueue(makeChunk({ content: part.text }, null));
        } else if (part.type === 'tool-input-start') {
          const toolIndex = nextToolIndex++;
          toolCallState.set(part.id, { index: toolIndex, started: true });
          controller.enqueue(makeChunk({
            tool_calls: [{
              index: toolIndex,
              id: part.id,
              type: 'function',
              function: { name: part.toolName, arguments: '' },
            }],
          }, null));
        } else if (part.type === 'tool-input-delta') {
          const state = toolCallState.get(part.id);
          if (state) {
            controller.enqueue(makeChunk({
              tool_calls: [{ index: state.index, function: { arguments: part.delta } }],
            }, null));
          }
        } else if (part.type === 'finish') {
          finishReason = part.finishReason === 'tool-calls' ? 'tool_calls' : 'stop';
        }
      }

      controller.enqueue(makeChunk({}, finishReason));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
