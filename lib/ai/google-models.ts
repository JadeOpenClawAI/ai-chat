// Gemini CLI and adjacent integrations often use alias-like model IDs.
// Normalize them to concrete IDs accepted by the Google model endpoints.
const GOOGLE_MODEL_ALIASES: Record<string, string> = {
  auto: 'gemini-3-pro-preview',
  pro: 'gemini-3-pro-preview',
  flash: 'gemini-3-flash-preview',
  'flash-lite': 'gemini-2.5-flash-lite',
  'auto-gemini-2.5': 'gemini-2.5-pro',
  'auto-gemini-3': 'gemini-3-pro-preview',
  'gemini-3': 'gemini-3-pro-preview',
  'gemini-3.1': 'gemini-3.1-pro-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
};

export function normalizeGoogleModelId(modelId: string): string {
  return GOOGLE_MODEL_ALIASES[modelId] ?? modelId;
}
