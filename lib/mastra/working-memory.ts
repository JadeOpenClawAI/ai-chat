import { z } from 'zod/v3';

const LOCATION_FIELDS = [
  'latitude',
  'longitude',
  'accuracyMeters',
  'timezone',
  'locale',
  'capturedAt',
  'source',
] as const;

export type LocationField = (typeof LOCATION_FIELDS)[number];

export const WorkingMemoryProfileSchema = z.object({
  profileSummary: z.string().optional(),
  preferences: z.array(z.string()).optional(),
  activeProjects: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  accuracyMeters: z.number().nullable().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  capturedAt: z.string().optional(),
  source: z.string().optional(),
}).passthrough();

export type WorkingMemoryProfile = z.infer<typeof WorkingMemoryProfileSchema>;

export type StoredLocation = Pick<WorkingMemoryProfile, LocationField>;

export const LocationPayloadSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0),
  timezone: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  capturedAt: z.string().datetime(),
  source: z.string().trim().min(1),
});

export const LocationDeletePayloadSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
});

export function parseWorkingMemoryProfile(raw: string | null | undefined): WorkingMemoryProfile {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = WorkingMemoryProfileSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

export function serializeWorkingMemoryProfile(profile: WorkingMemoryProfile): string {
  return JSON.stringify(profile, null, 2);
}

export function readStoredLocation(profile: WorkingMemoryProfile): StoredLocation | null {
  const hasCoordinates = typeof profile.latitude === 'number' && typeof profile.longitude === 'number';
  if (!hasCoordinates) {
    return null;
  }

  return {
    latitude: profile.latitude,
    longitude: profile.longitude,
    accuracyMeters: typeof profile.accuracyMeters === 'number' ? profile.accuracyMeters : null,
    timezone: profile.timezone,
    locale: profile.locale,
    capturedAt: profile.capturedAt,
    source: profile.source,
  };
}

export function mergeStoredLocation(
  profile: WorkingMemoryProfile,
  location: StoredLocation,
): WorkingMemoryProfile {
  return {
    ...profile,
    ...location,
  };
}

export function clearStoredLocation(profile: WorkingMemoryProfile): WorkingMemoryProfile {
  const next: WorkingMemoryProfile = { ...profile };
  for (const field of LOCATION_FIELDS) {
    delete next[field];
  }
  return next;
}
