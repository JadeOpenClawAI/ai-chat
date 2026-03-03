import { streamText } from 'ai';
import { z } from 'zod/v3';
import type { ProfileConfig, RouteTarget } from '@/lib/config/store';
import { composeSystemPrompts, readConfig } from '@/lib/config/store';
import { getDefaultModelForProvider, getLanguageModelForProfile, getProviderOptionsForCall } from '@/lib/ai/providers';

const RequestSchema = z.object({
  conversationId: z.string().optional(),
  profileId: z.string().optional(),
  model: z.string().optional(),
  useAutoRouting: z.boolean().optional(),
  previousTitle: z.string().optional(),
  stage: z.number().int().min(1).max(8).optional(),
  messages: z.array(
    z.object({
      role: z.string().optional(),
      content: z.unknown().optional(),
      parts: z.array(z.record(z.unknown())).optional(),
    }).passthrough(),
  ),
});

const TITLE_SYSTEM_PROMPT = `You write concise conversation titles for a sidebar.

Rules:
- Return title text only (no markdown, quotes, prefixes, or explanations)
- Keep it specific and descriptive
- 3 to 8 words
- 72 characters max
- Prefer concrete nouns and intent over generic phrasing
- No trailing punctuation`;

function textFromMessage(message: { parts?: Array<Record<string, unknown>>; content?: unknown }): string {
  if (Array.isArray(message.parts)) {
    const text = message.parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  return '';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fallbackTitleFromMessages(messages: Array<{ role?: string; parts?: Array<Record<string, unknown>>; content?: unknown }>): string {
  const firstUser = messages.find((message) => message.role === 'user');
  const text = normalizeWhitespace(textFromMessage(firstUser ?? {}));
  return text.slice(0, 60).trim() || 'New conversation';
}

function buildTranscript(messages: Array<{ role?: string; parts?: Array<Record<string, unknown>>; content?: unknown }>): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const text = normalizeWhitespace(textFromMessage(message));
    if (!text) {
      continue;
    }
    const speaker = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${speaker}: ${text}`);
  }
  if (lines.length === 0) {
    return '';
  }
  return lines.slice(-10).join('\n').slice(0, 7000);
}

function sanitizeTitle(raw: string): string {
  let title = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  title = normalizeWhitespace(title);
  title = title.replace(/^["'`]+|["'`]+$/g, '');
  title = title.replace(/[.!?,;:]+$/g, '');
  title = normalizeWhitespace(title);
  if (title.length > 72) {
    const clipped = title.slice(0, 72);
    const boundary = clipped.lastIndexOf(' ');
    title = (boundary >= 20 ? clipped.slice(0, boundary) : clipped).trim();
  }
  return title;
}

function resolveModelForProfile(profile: ProfileConfig, requestedModelId?: string): string {
  if (requestedModelId?.trim()) {
    return requestedModelId.trim();
  }
  if (profile.allowedModels.length > 0) {
    return profile.allowedModels[0];
  }
  return getDefaultModelForProvider(profile.provider);
}

function resolveRouteCandidates(
  profiles: ProfileConfig[],
  opts: {
    conversationState?: { activeProfileId: string; activeModelId: string };
    globalPrimary: RouteTarget;
    routingPriority: RouteTarget[];
    profileId?: string;
    modelId?: string;
    useAutoRouting: boolean;
  },
): RouteTarget[] {
  const seen = new Set<string>();
  const candidates: RouteTarget[] = [];
  const push = (profileId?: string, modelId?: string) => {
    const profile = profiles.find((p) => p.id === profileId && p.enabled);
    if (!profile) {
      return;
    }
    const resolvedModel = resolveModelForProfile(profile, modelId);
    if (!resolvedModel) {
      return;
    }
    const key = `${profile.id}:${resolvedModel}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ profileId: profile.id, modelId: resolvedModel });
  };

  const isPinnedManualRoute = !opts.useAutoRouting && Boolean(opts.profileId?.trim() && opts.modelId?.trim());
  if (isPinnedManualRoute) {
    push(opts.profileId, opts.modelId);
    return candidates;
  }

  push(opts.profileId, opts.modelId);
  push(opts.conversationState?.activeProfileId, opts.modelId ?? opts.conversationState?.activeModelId);
  push(opts.globalPrimary.profileId, opts.modelId ?? opts.globalPrimary.modelId);
  for (const route of opts.routingPriority) {
    push(route.profileId, route.modelId);
  }

  const firstEnabled = profiles.find((profile) => profile.enabled);
  if (firstEnabled) {
    push(firstEnabled.id, opts.modelId);
  }

  return candidates;
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
      conversationId,
      profileId,
      model,
      useAutoRouting = false,
      previousTitle,
      stage = 1,
      messages,
    } = parsed.data;

    if (messages.length === 0) {
      return Response.json({ title: 'New conversation', stage });
    }

    const fallbackTitle = fallbackTitleFromMessages(messages);
    const transcript = buildTranscript(messages);
    if (!transcript) {
      return Response.json({ title: fallbackTitle, stage });
    }

    const config = await readConfig();
    if (config.uiSettings?.aiConversationTitles === false) {
      return Response.json({ title: fallbackTitle, stage });
    }

    const globalPrimary = config.routing.modelPriority[0] ?? { profileId: '', modelId: '' };
    const conversationState = conversationId ? config.conversations[conversationId] : undefined;
    const candidates = resolveRouteCandidates(config.profiles, {
      conversationState,
      globalPrimary,
      routingPriority: config.routing.modelPriority,
      profileId,
      modelId: model,
      useAutoRouting,
    });
    if (candidates.length === 0) {
      return Response.json({ title: fallbackTitle, stage });
    }

    let resolved:
      | { model: Awaited<ReturnType<typeof getLanguageModelForProfile>>['model']; profile: ProfileConfig; modelId: string }
      | null = null;
    for (const candidate of candidates) {
      try {
        resolved = await getLanguageModelForProfile(candidate.profileId, candidate.modelId);
        break;
      } catch {
        // Try next route candidate
      }
    }
    if (!resolved) {
      return Response.json({ title: fallbackTitle, stage });
    }

    const previous = previousTitle?.trim() || '(none yet)';
    const prompt = `Current title: ${previous}
Refinement stage: ${stage}

Conversation transcript:
${transcript}

Write a clearer, more specific sidebar title. Return only the title text.`;

    const systemPrompts = composeSystemPrompts(resolved.profile, TITLE_SYSTEM_PROMPT);
    if (systemPrompts.length === 0) {
      systemPrompts.push(TITLE_SYSTEM_PROMPT);
    }
    const effectiveSystemPrompt = systemPrompts.join('\n\n').trim();
    const providerOptions = getProviderOptionsForCall(
      { provider: resolved.profile.provider, modelId: resolved.modelId },
      effectiveSystemPrompt,
    );
    const completion = await streamText({
      model: resolved.model,
      messages: [
        ...systemPrompts.map((content) => ({ role: 'system' as const, content })),
        { role: 'user', content: prompt },
      ],
      maxRetries: 0,
      ...(providerOptions ? { providerOptions } : {}),
    });
    await completion.consumeStream({
      onError: (error) => {
        console.error('[title] stream error', error instanceof Error ? error.message : String(error));
      },
    });
    const generated = sanitizeTitle(await completion.text);
    const finalTitle = generated || fallbackTitle;

    return Response.json({
      title: finalTitle,
      stage,
      profileId: resolved.profile.id,
      modelId: resolved.modelId,
    });
  } catch (error) {
    console.error('[title] fatal error', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
