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
      }),
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

  if (!body.stream) {
    let text = firstPart.text;
    for await (const part of rest) {
      if (part.type === 'text-delta') text += part.text;
    }
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

  // Stream mode — emit firstPart immediately, then stream rest live
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
      send(controller, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send(controller, 'ping', { type: 'ping' });

      send(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: firstPart.text },
      });

      for await (const part of rest) {
        if (part.type === 'text-delta') {
          send(controller, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: part.text },
          });
        }
      }

      send(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      send(controller, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
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
