import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { readConfig } from '@/lib/config/store';
import { getLanguageModelForProfile, getProviderOptionsForCall } from '@/lib/ai/providers';
import { LLMProvider } from '@/lib/types';
import { resolveModel } from '../resolve-model';

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

  let profileId: string;
  let resolvedModelId: string;
  try {
    const resolved = resolveModel(body.model, config);
    profileId = resolved.profileId;
    resolvedModelId = resolved.resolvedModelId;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const coreMessages = body.messages.map((msg) => ({
    role: msg.role,
    content: messageContent(msg.content),
  }));

  let model: Awaited<ReturnType<typeof getLanguageModelForProfile>>['model'];
  try {
    const result = await getLanguageModelForProfile(profileId, resolvedModelId);
    model = result.model;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  // Normalize system: Anthropic SDK sends it as array of content blocks
  const systemPrompt = Array.isArray(body.system)
    ? body.system.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n')
    : body.system;

  const msgId = `msg_${Date.now()}`;

  try {
    const result = streamText({
      model,
      messages: coreMessages,
      providerOptions: getProviderOptionsForCall({
        provider: profileId.split(':').shift() as LLMProvider,
        modelId: resolvedModelId,
      }, systemPrompt || 'Please respond to the user\'s message.'),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
      maxRetries: 0,
    });

    // Eagerly collect all stream parts so we can return a proper HTTP error
    // before committing to an SSE response if something goes wrong.
    const parts: TextStreamPart<ToolSet>[] = [];
    let streamError: string | undefined;
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'error') {
          streamError = (part.error as Error)?.message ?? String(part.error);
        } else {
          parts.push(part);
        }
      }
    } catch (err) {
      streamError = (err as Error).message ?? String(err);
    }

    if (streamError) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: streamError } },
        { status: 502 },
      );
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

    // Stream mode — all parts are buffered, emit them synchronously
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
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
