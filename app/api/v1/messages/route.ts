import { type TextStreamPart, type ToolSet } from 'ai';
import { readConfig } from '@/lib/config/store';
import { getProviderOptionsForCall } from '@/lib/ai/providers';
import type { LLMProvider } from '@/lib/types';
import { resolveModel } from '../resolve-model';
import { streamWithFallback, buildAutoTargets } from '@/lib/ai/stream-with-fallback';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
}

interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number;
  stream?: boolean;
}

function messageContent(content: AnthropicMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

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

  const coreMessages = body.messages.map((msg) => ({
    role: msg.role,
    content: messageContent(msg.content),
  }));

  // Normalize system: Anthropic SDK sends it as array of content blocks
  const systemPrompt = Array.isArray(body.system)
    ? body.system.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n')
    : body.system;

  const msgId = `msg_${Date.now()}`;

  let parts: TextStreamPart<ToolSet>[];
  let usedProfileId: string;
  let failures: Array<{ profileId: string; modelId: string; error: string }>;

  try {
    const result = await streamWithFallback(
      targets,
      (profileId, modelId) => ({
        messages: coreMessages,
        providerOptions: getProviderOptionsForCall(
          { provider: profileId.split(':').shift() as LLMProvider, modelId },
          systemPrompt ?? '',
        ),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
      }),
      isAuto ? config.routing.maxAttempts : 1,
    );
    parts = result.parts;
    usedProfileId = result.profileId;
    failures = result.failures;
  } catch (err) {
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: (err as Error).message } },
      { status: 502 },
    );
  }

  if (failures.length > 0) {
    console.info('[v1/messages] auto-routing used fallback', { usedProfileId, failures });
  }

  if (!body.stream) {
    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p as { type: 'text-delta'; text: string }).text)
      .join('');
    return Response.json({
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: body.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  // Stream mode — all parts already buffered, emit synchronously
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      send('message_start', {
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
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send('ping', { type: 'ping' });

      for (const part of parts) {
        if (part.type === 'text-delta') {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: (part as { type: 'text-delta'; text: string }).text },
          });
        }
      }

      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      send('message_stop', { type: 'message_stop' });
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
