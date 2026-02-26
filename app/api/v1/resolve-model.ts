import type { AppConfig } from '@/lib/config/store';

export interface ResolvedModel {
  profileId: string;
  resolvedModelId: string;
}

/**
 * Resolve a caller-supplied model string to an internal profile + model ID.
 *
 * Accepted formats:
 *   "auto"                        — use the first entry in routing.modelPriority
 *   "profileId/modelId"           — e.g. "openai:openrouter/arcee-ai/trinity:free"
 *   "providerName/modelId"        — e.g. "openai/gpt-4o" (matches first enabled profile with that provider)
 *
 * The resolved modelId MUST appear in the profile's allowedModels list (if non-empty).
 * Throws a descriptive Error on any validation failure.
 */
export function resolveModel(modelId: string, config: AppConfig): ResolvedModel {
  if (modelId === 'auto') {
    const primary = config.routing.modelPriority[0];
    if (!primary) throw new Error('No model configured');
    return { profileId: primary.profileId, resolvedModelId: primary.modelId };
  }

  const slashIdx = modelId.indexOf('/');
  if (slashIdx === -1) {
    // Build a list of valid model strings to help the caller
    const valid = buildValidModelList(config);
    throw new Error(
      `Invalid model "${modelId}". Expected "auto" or "profileId/modelId". ` +
      `Valid options: ${valid.join(', ')}`,
    );
  }

  const hint = modelId.slice(0, slashIdx);
  const resolvedModelId = modelId.slice(slashIdx + 1);

  const profile = config.profiles.find((p) => p.enabled && (p.id === hint || p.provider === hint));
  if (!profile) {
    const profileIds = config.profiles.filter((p) => p.enabled).map((p) => p.id);
    throw new Error(
      `No enabled profile found for "${hint}". ` +
      `Available profile IDs: ${profileIds.join(', ')}`,
    );
  }

  if (profile.allowedModels.length > 0 && !profile.allowedModels.includes(resolvedModelId)) {
    throw new Error(
      `Model "${resolvedModelId}" is not allowed for profile "${profile.id}". ` +
      `Allowed models: ${profile.allowedModels.join(', ')}`,
    );
  }

  return { profileId: profile.id, resolvedModelId };
}

/** Returns all valid "profileId/modelId" strings across enabled profiles. */
function buildValidModelList(config: AppConfig): string[] {
  const items: string[] = ['auto'];
  for (const p of config.profiles) {
    if (!p.enabled) continue;
    for (const m of p.allowedModels) {
      items.push(`${p.id}/${m}`);
    }
  }
  return items;
}
