import type { AppConfig } from '@/lib/config/store';
import { getAutoTargetsForActivity } from '@/lib/ai/activity-routing';

export interface ResolvedModel {
  isAuto: boolean;
  activityId?: string;
  targets: Array<{ profileId: string; modelId: string }>;
}

/**
 * Resolve a caller-supplied model string to internal route targets.
 *
 * Accepted formats:
 *   "auto"                 — use default auto activity profile
 *   "auto:<activityId>"    — use explicit auto activity profile
 *   "profileId/modelId"    — explicit profile/model route
 *
 * Explicit modelId MUST appear in the profile's allowedModels list (if non-empty).
 * Throws a descriptive Error on any validation failure.
 */
export function resolveModel(modelId: string, config: AppConfig): ResolvedModel {
  if (modelId === 'auto') {
    const { activity, targets } = getAutoTargetsForActivity(config, { strictRequested: true });
    if (targets.length === 0) {
      throw new Error('No models configured for default auto activity');
    }
    return {
      isAuto: true,
      activityId: activity.id,
      targets,
    };
  }

  const autoAliasMatch = modelId.match(/^auto:([a-zA-Z0-9._-]+)$/);
  if (autoAliasMatch) {
    const requestedActivityId = autoAliasMatch[1]!;
    const { activity, targets } = getAutoTargetsForActivity(config, {
      requestedActivityId,
      strictRequested: true,
    });
    if (targets.length === 0) {
      throw new Error(`No models configured for auto activity "${requestedActivityId}"`);
    }
    return {
      isAuto: true,
      activityId: activity.id,
      targets,
    };
  }

  const slashIdx = modelId.indexOf('/');
  if (slashIdx === -1) {
    // Build a list of valid model strings to help the caller
    const valid = buildValidModelList(config);
    throw new Error(
      `Invalid model "${modelId}". Expected "auto", "auto:<activityId>", or "profileId/modelId". ` +
      `Valid options: ${valid.join(', ')}`,
    );
  }

  const hint = modelId.slice(0, slashIdx);
  const resolvedModelId = modelId.slice(slashIdx + 1);

  const profile = config.profiles.find((p) => p.enabled && p.id === hint);
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

  return {
    isAuto: false,
    targets: [{ profileId: profile.id, modelId: resolvedModelId }],
  };
}

/** Returns all valid "profileId/modelId" strings across enabled profiles. */
function buildValidModelList(config: AppConfig): string[] {
  const items: string[] = ['auto', ...config.routing.activityProfiles.map((activity) => `auto:${activity.id}`)];
  for (const p of config.profiles) {
    if (!p.enabled) {
      continue;
    }
    for (const m of p.allowedModels) {
      items.push(`${p.id}/${m}`);
    }
  }
  return items;
}
