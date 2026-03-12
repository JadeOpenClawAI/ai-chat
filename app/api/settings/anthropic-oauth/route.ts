import { readConfig, writeConfig } from '@/lib/config/store';
import { clearAnthropicTokenCache, refreshAnthropicToken, resolveAnthropicOAuthRefreshToken } from '@/lib/ai/anthropic-auth';
import { getDefaultAllowedModelsForProvider } from '@/lib/types';

function getOrCreateAnthropicProfile(config: Awaited<ReturnType<typeof readConfig>>, profileId?: string) {
  let profile = profileId
    ? config.profiles.find((p) => p.provider === 'anthropic-oauth' && p.id === profileId)
    : config.profiles.find((p) => p.provider === 'anthropic-oauth');

  if (!profile) {
    profile = {
      id: 'anthropic-oauth:oauth',
      provider: 'anthropic-oauth',
      displayName: 'Anthropic OAuth',
      enabled: true,
      extraHeaders: {
        'anthropic-beta': 'oauth-2025-04-20',
      },
      allowedModels: getDefaultAllowedModelsForProvider('anthropic-oauth'),
      systemPrompts: [],
    };
    config.profiles.push(profile);
  }

  return profile;
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; profileId?: string };
  const config = await readConfig();
  const profile = getOrCreateAnthropicProfile(config, body.profileId);

  if (body.action === 'status') {
    const hasRefreshToken = !!resolveAnthropicOAuthRefreshToken({
      id: profile.id,
      anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
    });
    const hasAccessToken = !!(profile.claudeAuthToken && profile.claudeAuthToken !== '***');
    return Response.json({
      hasRefreshToken,
      hasAccessToken,
      connected: hasRefreshToken || hasAccessToken,
    });
  }

  if (body.action === 'refresh') {
    try {
      await refreshAnthropicToken({
        id: profile.id,
        claudeAuthToken: profile.claudeAuthToken,
        anthropicOAuthExpiresAt: profile.anthropicOAuthExpiresAt,
        anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
      });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (profile.claudeAuthToken && profile.claudeAuthToken !== '***') {
        return Response.json({
          ok: true,
          degraded: true,
          warning: 'refresh_failed_using_cached_access_token',
          error: message,
        });
      }
      return Response.json({ ok: false, error: message });
    }
  }

  if (body.action === 'revoke') {
    clearAnthropicTokenCache({
      id: profile.id,
      anthropicOAuthRefreshToken: profile.anthropicOAuthRefreshToken,
    });
    profile.anthropicOAuthRefreshToken = undefined;
    profile.claudeAuthToken = undefined;
    profile.anthropicOAuthExpiresAt = undefined;
    await writeConfig(config);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
