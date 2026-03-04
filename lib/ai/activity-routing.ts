import type { ActivityRoutingProfile, AppConfig, RouteTarget } from '@/lib/config/store';

function dedupeTargets(targets: RouteTarget[]): RouteTarget[] {
  const seen = new Set<string>();
  const out: RouteTarget[] = [];
  for (const target of targets) {
    const key = `${target.profileId}/${target.modelId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(target);
  }
  return out;
}

export function getActivityProfile(config: AppConfig, activityId: string | undefined): ActivityRoutingProfile | undefined {
  if (!activityId) {
    return undefined;
  }
  return config.routing.activityProfiles.find((activity) => activity.id === activityId);
}

export function getDefaultActivityProfile(config: AppConfig): ActivityRoutingProfile {
  return (
    getActivityProfile(config, config.routing.defaultActivityProfileId)
    ?? config.routing.activityProfiles[0]
  )!;
}

export function resolveAutoActivityProfile(
  config: AppConfig,
  options: {
    requestedActivityId?: string;
    conversationActivityId?: string;
    strictRequested?: boolean;
  } = {},
): ActivityRoutingProfile {
  const requested = options.requestedActivityId?.trim();
  if (requested) {
    const activity = getActivityProfile(config, requested);
    if (activity) {
      return activity;
    }
    if (options.strictRequested) {
      const valid = config.routing.activityProfiles.map((item) => item.id).join(', ');
      throw new Error(`Unknown auto activity "${requested}". Valid activities: ${valid}`);
    }
  }

  const conversation = options.conversationActivityId?.trim();
  if (conversation) {
    const activity = getActivityProfile(config, conversation);
    if (activity) {
      return activity;
    }
  }

  return getDefaultActivityProfile(config);
}

export function getAutoTargetsForActivity(
  config: AppConfig,
  options: {
    requestedActivityId?: string;
    conversationActivityId?: string;
    strictRequested?: boolean;
  } = {},
): { activity: ActivityRoutingProfile; targets: RouteTarget[] } {
  const activity = resolveAutoActivityProfile(config, options);
  return {
    activity,
    targets: dedupeTargets(activity.modelPriority),
  };
}

export function getPrimaryRouteTarget(config: AppConfig): RouteTarget {
  const defaultActivity = getDefaultActivityProfile(config);
  return defaultActivity.modelPriority[0] ?? { profileId: config.profiles[0]?.id ?? '', modelId: '' };
}

