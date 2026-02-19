# Codex gpt-5.2-codex Forbidden Fix — Patch Plan

## Root Cause Analysis

The `gpt-5.*` codex models hit `chatgpt.com/backend-api` which is **NOT** the standard
OpenAI API. Three concrete bugs in the current implementation cause 403 Forbidden:

### Bug 1 — Wrong Endpoint Path (CRITICAL)

In `lib/ai/providers.ts`, `createCodexProvider` creates an `@ai-sdk/openai` provider with
`baseURL: 'https://chatgpt.com/backend-api'`. When `.responses(modelId)` is called, the
AI SDK appends `/responses` → making requests to:

```
https://chatgpt.com/backend-api/responses        ← WRONG
```

The chatgpt.com backend requires:

```
https://chatgpt.com/backend-api/codex/responses  ← CORRECT
```

**Fix**: Set `baseURL: 'https://chatgpt.com/backend-api/codex'` so that the SDK's
hardcoded `/responses` path resolves to the correct endpoint.

### Bug 2 — Missing Required Headers (CRITICAL)

The chatgpt.com backend-api requires headers that the standard `@ai-sdk/openai` client
does not know about:

| Header | Required Value | Source |
|--------|---------------|--------|
| `chatgpt-account-id` | JWT claim `https://api.openai.com/auth.chatgpt_account_id` | Decode access token |
| `OpenAI-Beta` | `responses=experimental` | Hardcoded |
| `originator` | `pi` | Hardcoded |

These are verified from OpenClaw's `@mariozechner/pi-ai` provider implementation at:
`/app/node_modules/.pnpm/@mariozechner+pi-ai@0.53.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js`

```js
// From buildHeaders() in openai-codex-responses.js:
headers.set("Authorization", `Bearer ${token}`);
headers.set("chatgpt-account-id", accountId);   // ← MISSING in current code
headers.set("OpenAI-Beta", "responses=experimental");  // ← MISSING
headers.set("originator", "pi");                 // ← MISSING
headers.set("accept", "text/event-stream");
headers.set("content-type", "application/json");
```

### Bug 3 — Missing Account ID Extraction (CRITICAL)

The `chatgpt-account-id` value must be decoded from the **JWT access token** at the claim
path `https://api.openai.com/auth.chatgpt_account_id`. The current code has no JWT
parsing logic.

```js
// From openai-codex-responses.js extractAccountId():
const parts = token.split(".");
const payload = JSON.parse(atob(parts[1]));
const accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
```

### Bug 4 — Optional Body Fields Missing (LOW PRIORITY)

OpenClaw's provider also sends these body fields that the ai-sdk doesn't send:
- `store: false`
- `text: { verbosity: "medium" }`
- `include: ["reasoning.encrypted_content"]`
- `prompt_cache_key: sessionId`

These may or may not be required; the 403 is almost certainly caused by Bugs 1–3.

---

## Concrete Patch Plan

### Patch 1 — `lib/ai/codex-auth.ts`

Add `extractAccountId()` helper function:

```typescript
// Add after DEFAULT_CODEX_CLIENT_ID constant:

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the ChatGPT account ID from an OAuth JWT access token.
 * The account ID is required as the `chatgpt-account-id` header for
 * chatgpt.com/backend-api requests.
 *
 * @throws Error if the token is malformed or missing the account ID claim
 */
export function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(atob(parts[1])) as Record<string, unknown>
    const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined
    const accountId = auth?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId) {
      throw new Error(`No chatgpt_account_id in JWT claim '${JWT_CLAIM_PATH}'`)
    }
    return accountId
  } catch (err) {
    throw new Error(`Failed to extract accountId from token: ${err instanceof Error ? err.message : err}`)
  }
}
```

---

### Patch 2 — `lib/ai/providers.ts`

Update the codex branch in `modelFromProfile()`:

```typescript
// BEFORE:
if (profile.provider === 'codex') {
  const useChatGptBackend = modelId.startsWith('gpt-5.')
  const codexProvider = await createCodexProvider({
    codexClientId: profile.codexClientId,
    codexClientSecret: profile.codexClientSecret,
    codexRefreshToken: profile.codexRefreshToken,
  }, {
    baseURL: useChatGptBackend ? 'https://chatgpt.com/backend-api' : (profile.baseUrl ?? 'https://api.openai.com/v1'),
    extraHeaders: profile.extraHeaders,
  })

  if (useChatGptBackend) {
    const responsesModel = (codexProvider as unknown as { responses?: (id: string) => LanguageModel }).responses?.(modelId)
    if (responsesModel) return responsesModel
  }

  return codexProvider(modelId)
}
```

```typescript
// AFTER:
import { extractAccountId } from './codex-auth'

// ...inside modelFromProfile():

if (profile.provider === 'codex') {
  const useChatGptBackend = modelId.startsWith('gpt-5.')

  if (useChatGptBackend) {
    // chatgpt.com/backend-api requires:
    //   1. baseURL ending in /codex so SDK path /responses → /codex/responses
    //   2. chatgpt-account-id header (from JWT)
    //   3. OpenAI-Beta: responses=experimental
    //   4. originator: pi

    const accessToken = await refreshCodexToken({
      codexClientId: profile.codexClientId,
      codexClientSecret: profile.codexClientSecret,
      codexRefreshToken: profile.codexRefreshToken,
    })

    const accountId = extractAccountId(accessToken)

    const codexProvider = await createCodexProvider({
      codexClientId: profile.codexClientId,
      codexClientSecret: profile.codexClientSecret,
      codexRefreshToken: profile.codexRefreshToken,
    }, {
      // KEY FIX: path /responses → /codex/responses
      baseURL: 'https://chatgpt.com/backend-api/codex',
      extraHeaders: {
        'chatgpt-account-id': accountId,        // KEY FIX: decoded from JWT
        'OpenAI-Beta': 'responses=experimental',  // KEY FIX: required by backend
        'originator': 'pi',                        // KEY FIX: expected by backend
        ...(profile.extraHeaders ?? {}),
      },
    })

    const responsesModel = (codexProvider as unknown as { responses?: (id: string) => LanguageModel }).responses?.(modelId)
    if (responsesModel) return responsesModel
    // Fallback to chat completions if .responses() not available
    return codexProvider(modelId)
  }

  // Non-gpt-5.* codex models: use standard OpenAI API
  const codexProvider = await createCodexProvider({
    codexClientId: profile.codexClientId,
    codexClientSecret: profile.codexClientSecret,
    codexRefreshToken: profile.codexRefreshToken,
  }, {
    baseURL: profile.baseUrl ?? 'https://api.openai.com/v1',
    extraHeaders: profile.extraHeaders,
  })
  return codexProvider(modelId)
}
```

**Important**: Also add `refreshCodexToken` to the import from `./codex-auth`:
```typescript
import { createCodexProvider, extractAccountId, refreshCodexToken } from './codex-auth'
```

---

### Patch 3 — `lib/ai/codex-auth.ts` (tweak `createCodexProvider`)

The current `createCodexProvider` calls `refreshCodexToken` internally and sets the
`Authorization` header. It also needs to **not double-set** the Bearer token, since the
`createOpenAI` factory already handles auth via `apiKey`. Clean this up:

**Current code** (keep as-is but verify Authorization header isn't duplicated):
```typescript
return createOpenAI({
  apiKey: accessToken,
  baseURL: options?.baseURL ?? 'https://api.openai.com/v1',
  headers: {
    Authorization: `Bearer ${accessToken}`,  // redundant but harmless
    ...(options?.extraHeaders ?? {}),
  },
})
```

The `apiKey` param already sets the Bearer token in `@ai-sdk/openai`. The explicit
`Authorization` header in `headers` overrides it (fine). No change needed here — the
extra headers from Patch 2 will be passed via `extraHeaders` correctly.

---

## Additional Notes

### Why `.responses()` vs `codexProvider(modelId)`?

- `codexProvider(modelId)` → uses the **Chat Completions** API (`/chat/completions`).
  The chatgpt.com backend does NOT support the standard Chat Completions endpoint.

- `codexProvider.responses?.(modelId)` → uses the **Responses API** format (`/responses`
  path). The Responses API body format (`input`, `instructions`) is what chatgpt.com
  /codex/responses expects.

After Patch 2, `.responses(modelId)` hits the correct path `/codex/responses` with the
right headers. This is the right approach.

### Token Cache Invalidation

The current `tokenCache` in `codex-auth.ts` is module-level (shared). This works fine
as long as tokens are valid. The `extractAccountId` call adds ~0 latency (pure string
parsing). The `refreshCodexToken` call before `createCodexProvider` is the only extra
work — but since the cache is module-level, it will return the cached token on the 2nd+
call with no extra network round-trips.

### Model-Specific Reasoning Clamping

OpenClaw's provider clamps reasoning effort for specific codex model IDs:
- `gpt-5.2-codex` / `gpt-5.3-codex`: `minimal` → `low`
- `gpt-5.1`: `xhigh` → `high`
- `gpt-5.1-codex-mini`: always `medium` or `high`

If reasoning effort needs to be set, use the ai-sdk's provider options:
```typescript
// In chat route or wherever streamText is called:
experimental_providerMetadata: {
  openai: { reasoningEffort: 'low', reasoningSummary: 'auto' }
}
```

### WebSocket Transport (Future)

OpenClaw's provider also supports WebSocket transport for lower latency:
`wss://chatgpt.com/backend-api/codex/responses`

This is not needed for the fix but is worth knowing if SSE proves unreliable.

### Forward-Compat Understanding

OpenClaw treats `gpt-5.2-codex` as a *template* for `gpt-5.3-codex` (forward-compat
pattern). In the ai-chat project, both models are listed explicitly in `types.ts` —
no special forwarding needed. Both will work with the same fix since both match
`modelId.startsWith('gpt-5.')`.

---

## Files to Change

| File | Change Type |
|------|-------------|
| `lib/ai/codex-auth.ts` | Add `extractAccountId()` export |
| `lib/ai/providers.ts` | Fix baseURL, add required headers, import `extractAccountId` + `refreshCodexToken` |

## Files NOT to Change

- `app/api/auth/codex/authorize/route.ts` — OAuth flow correct
- `app/api/auth/codex/callback/route.ts` — OAuth callback correct
- `lib/ai/pkce.ts` — PKCE correct
- `app/api/chat/route.ts` — no changes needed; provider fix is transparent

---

## Quick Validation After Patch

After applying the patches, test with:

1. Verify token refresh works: `GET /api/settings/test` (check codex profile)
2. Send a message with gpt-5.2-codex — should get a 200 SSE stream from backend
3. Verify `chatgpt-account-id` is being sent (add temporary debug log in providers.ts)

If 403 persists after this fix, check:
- That the access token is valid and fresh (re-auth if needed)
- That the account has ChatGPT Plus/Pro subscription (codex requires active sub)
- Network trace to confirm the correct URL and headers are being sent
