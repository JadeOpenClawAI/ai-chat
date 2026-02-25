import { streamText } from 'ai';
import { readConfig, type AppConfig } from '@/lib/config/store';
import { getLanguageModelForProfile } from '@/lib/ai/providers';

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

function resolveModel(modelId: string, config: AppConfig) {
  if (modelId === 'auto') {
    const primary = config.routing.modelPriority[0];
    if (!primary) throw new Error('No model configured');
    return { profileId: primary.profileId, resolvedModelId: primary.modelId };
  }
  const slashIdx = modelId.indexOf('/');
  if (slashIdx === -1) {
    const profile = config.profiles.find((p) => p.enabled);
    if (!profile) throw new Error('No enabled profile found');
    return { profileId: profile.id, resolvedModelId: modelId };
  }
  // Everything before the first '/' is the profile hint (matches profile ID or provider name).
  // Everything after is the model ID passed to the upstream provider.
  const hint = modelId.slice(0, slashIdx);
  const resolvedModelId = modelId.slice(slashIdx + 1);
  const profile = config.profiles.find((p) => p.enabled && (p.id === hint || p.provider === hint));
  if (!profile) throw new Error(`No enabled profile found for: ${hint}`);
  return { profileId: profile.id, resolvedModelId };
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
  const created = Math.floor(Date.now() / 1000);

  try {
    const result = streamText({
      model,
      messages: coreMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
      maxRetries: 0,
    });

    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          function send(event: string, data: unknown) {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          }

          try {
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

            for await (const chunk of result.textStream) {
              send('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: chunk },
              });
            }

            send('content_block_stop', { type: 'content_block_stop', index: 0 });
            send('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 },
            });
            send('message_stop', { type: 'message_stop' });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      const text = await result.text;
      return Response.json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: body.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: created },
      });
    }
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
