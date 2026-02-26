import { readConfig, composeSystemPrompt, getProfileById } from '@/lib/config/store';
import { getProviderOptionsForCall } from '@/lib/ai/providers';
import type { LLMProvider } from '@/lib/types';
import { resolveModel } from '../resolve-model';
import { streamWithFallback, buildAutoTargets } from '@/lib/ai/stream-with-fallback';
import { tool, jsonSchema, type ToolSet } from 'ai';

// ── Anthropic request types ──────────────────────────────────────────────────

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
}

interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function blockText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function toolResultText(block: AnthropicToolResultBlock): string {
  if (!block.content) return '';
  if (typeof block.content === 'string') return block.content;
  return block.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/** Convert Anthropic messages to AI SDK ModelMessage format. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertMessages(messages: AnthropicMessage[]): any[] {
  // Build a map of tool_use id → name from assistant messages for tool result lookup
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameMap.set((block as AnthropicToolUseBlock).id, (block as AnthropicToolUseBlock).name);
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const b = block as AnthropicToolUseBlock;
          parts.push({ type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input });
        }
      }
      out.push({ role: 'assistant', content: parts });
    } else {
      // user — may contain tool_result blocks
      const toolResults = msg.content.filter(
        (b): b is AnthropicToolResultBlock => b.type === 'tool_result',
      );
      const textBlocks = msg.content.filter(
        (b): b is AnthropicTextBlock => b.type === 'text',
      );

      if (toolResults.length > 0) {
        out.push({
          role: 'tool',
          content: toolResults.map((b) => ({
            type: 'tool-result',
            toolCallId: b.tool_use_id,
            toolName: toolNameMap.get(b.tool_use_id) ?? '',
            output: { type: 'text', value: toolResultText(b) },
          })),
        });
        if (textBlocks.length > 0) {
          out.push({ role: 'user', content: blockText(msg.content as AnthropicContentBlock[]) });
        }
      } else {
        out.push({ role: 'user', content: blockText(msg.content as AnthropicContentBlock[]) });
      }
    }
  }
  return out;
}

/** Convert Anthropic tools array to AI SDK ToolSet. */
function buildTools(tools: AnthropicTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: jsonSchema(t.input_schema as any),
    });
  }
  return set;
}

/** Convert Anthropic tool_choice to AI SDK toolChoice. */
function convertToolChoice(
  tc: AnthropicToolChoice | undefined,
): string | { type: 'tool'; toolName: string } | undefined {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'tool', toolName: tc.name };
  return undefined;
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const config = await readConfig();

  if (!config.apiEndpoints?.enableAnthropicCompat) {
    return Response.json({ error: 'Anthropic-compatible endpoint is disabled' }, { status: 403 });
  }

  const requiredKey = config.apiEndpoints?.endpointApiKey?.trim();
  if (requiredKey) {
    const authHeader = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (provided !== requiredKey) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let body: AnthropicMessagesRequest;
  try {
    body = (await req.json()) as AnthropicMessagesRequest;
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

  const coreMessages = convertMessages(body.messages);

  // Normalize system: Anthropic SDK sends it as array of content blocks
  const incomingSystem = Array.isArray(body.system)
    ? body.system.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n')
    : body.system;

  const sdkTools = buildTools(body.tools);
  const sdkToolChoice = convertToolChoice(body.tool_choice);

  const msgId = `msg_${Date.now()}`;

  let streamResult: Awaited<ReturnType<typeof streamWithFallback>>;
  try {
    streamResult = await streamWithFallback(
      targets,
      (profileId, modelId) => {
        // Compose profile system prompts (requiredFirstSystemPrompt + systemPrompts) with the
        // request's system so that per-profile required instructions are always honored.
        const profile = getProfileById(config, profileId);
        const composedSystem = profile
          ? composeSystemPrompt(profile, incomingSystem ?? undefined)
          : (incomingSystem ?? '');
        return {
          messages: coreMessages,
          providerOptions: getProviderOptionsForCall(
            { provider: profileId.split(':').shift() as LLMProvider, modelId },
            composedSystem,
          ),
          ...(composedSystem ? { system: composedSystem } : {}),
          ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
          ...(body.top_k !== undefined ? { topK: body.top_k } : {}),
          ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
          ...(sdkTools ? { tools: sdkTools } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(sdkToolChoice ? { toolChoice: sdkToolChoice as any } : {}),
        };
      },
      isAuto ? config.routing.maxAttempts : 1,
    );
  } catch (err) {
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: (err as Error).message } },
      { status: 502 },
    );
  }

  const { firstPart, rest, profileId: usedProfileId, failures } = streamResult;

  if (failures.length > 0) {
    console.info('[v1/messages] auto-routing used fallback', { usedProfileId, failures });
  }

  const encoder = new TextEncoder();
  function send(controller: ReadableStreamDefaultController, event: string, data: unknown) {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  // Async generator that yields firstPart then all remaining parts
  async function* allParts() {
    yield firstPart;
    for await (const p of rest) yield p;
  }

  if (!body.stream) {
    let text = '';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let stopReason = 'end_turn';

    for await (const part of allParts()) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'tool-call') {
        toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
      } else if (part.type === 'finish') {
        stopReason = part.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn';
      }
    }

    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const tc of toolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    return Response.json({
      id: msgId,
      type: 'message',
      role: 'assistant',
      content,
      model: body.model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  // Stream mode — process all parts, emit Anthropic SSE events
  const stream = new ReadableStream({
    async start(controller) {
      send(controller, 'message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: body.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send(controller, 'ping', { type: 'ping' });

      let nextBlockIndex = 0;
      let textBlockIndex: number | undefined;
      // toolCallId → block index for tool_use blocks
      const toolBlockIndexes = new Map<string, number>();
      let stopReason = 'end_turn';

      for await (const part of allParts()) {
        if (part.type === 'text-delta') {
          if (textBlockIndex === undefined) {
            textBlockIndex = nextBlockIndex++;
            send(controller, 'content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          send(controller, 'content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: part.text },
          });
        } else if (part.type === 'tool-input-start') {
          const blockIndex = nextBlockIndex++;
          toolBlockIndexes.set(part.id, blockIndex);
          send(controller, 'content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: part.id, name: part.toolName, input: {} },
          });
        } else if (part.type === 'tool-input-delta') {
          const blockIndex = toolBlockIndexes.get(part.id);
          if (blockIndex !== undefined) {
            send(controller, 'content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: part.delta },
            });
          }
        } else if (part.type === 'tool-input-end') {
          const blockIndex = toolBlockIndexes.get(part.id);
          if (blockIndex !== undefined) {
            send(controller, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
          }
        } else if (part.type === 'finish') {
          stopReason = part.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn';
        }
      }

      // Close text block if it was opened
      if (textBlockIndex !== undefined) {
        send(controller, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
      }

      send(controller, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      send(controller, 'message_stop', { type: 'message_stop' });
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
