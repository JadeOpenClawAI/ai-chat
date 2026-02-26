import { readConfig } from '@/lib/config/store';
import { getProviderOptionsForCall } from '@/lib/ai/providers';
import type { LLMProvider } from '@/lib/types';
import { resolveModel } from '../../resolve-model';
import { streamWithFallback, buildAutoTargets } from '@/lib/ai/stream-with-fallback';

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

  function makeChunk(text: string) {
    return encoder.encode(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`);
  }

  if (!body.stream) {
    // Collect remaining text to build non-streaming response
    let text = firstPart.text;
    for await (const part of rest) {
      if (part.type === 'text-delta') text += part.text;
    }
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

  // Stream mode — emit firstPart immediately, then stream rest live
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(makeChunk(firstPart.text));
      for await (const part of rest) {
        if (part.type === 'text-delta') {
          controller.enqueue(makeChunk(part.text));
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
}
