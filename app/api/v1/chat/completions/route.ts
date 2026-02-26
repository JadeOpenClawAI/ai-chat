import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { readConfig, type AppConfig } from '@/lib/config/store';
import { getLanguageModelForProfile, getProviderOptionsForCall } from '@/lib/ai/providers';
import { LLMProvider } from '@/lib/types';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
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

function messageContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

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

  let profileId: string;
  let resolvedModelId: string;
  try {
    const resolved = resolveModel(body.model, config);
    profileId = resolved.profileId;
    resolvedModelId = resolved.resolvedModelId;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  // Extract system message and convert to AI SDK messages
  let systemPrompt: string | undefined;
  const coreMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const msg of body.messages) {
    if (msg.role === 'system') {
      systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + messageContent(msg.content);
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      coreMessages.push({ role: msg.role, content: messageContent(msg.content) });
    }
  }

  let model: Awaited<ReturnType<typeof getLanguageModelForProfile>>['model'];
  try {
    const result = await getLanguageModelForProfile(profileId, resolvedModelId);
    model = result.model;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

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
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
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
        { error: { message: streamError, type: 'server_error' } },
        { status: 502 },
      );
    }

    if (!body.stream) {
      const text = parts
        .filter((p) => p.type === 'text-delta')
        .map((p) => (p as { type: 'text-delta'; text: string }).text)
        .join('');
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // Stream mode — all parts are buffered, emit them synchronously
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const part of parts) {
          if (part.type === 'text-delta') {
            const data = JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: body.model,
              choices: [{ index: 0, delta: { content: (part as { type: 'text-delta'; text: string }).text }, finish_reason: null }],
            });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
        }
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
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
