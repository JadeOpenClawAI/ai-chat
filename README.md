# AI Chat

A production-quality, full-stack AI chat application built with Next.js 15, the Vercel AI SDK, and @assistant-ui/react.

![AI Chat Interface](docs/screenshot-placeholder.png)

---

## ✨ Features

- **Multi-provider LLM support** — Anthropic Claude + OpenAI in one app, switchable per conversation
- **Streaming responses** — real-time token streaming via Vercel AI SDK data stream protocol
- **Multi-modal input** — drag & drop images, PDFs, text files, and videos
- **Tool calling with progress UI** — animated state indicators (pending → running → summarizing → done)
- **Automatic context management** — tracks token usage, auto-compacts old messages using AI summarization when approaching limits
- **Tool result summarization** — oversized tool outputs are automatically condensed to save context
- **Context stats bar** — live token counter with visual usage meter
- **Model/provider selector** — switch between Claude and GPT models without reloading
- **Dark mode support** — system preference aware

---

## 🚀 Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd ai-chat
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in at least one API key:

```env
ANTHROPIC_API_KEY=sk-ant-...   # For Claude models
OPENAI_API_KEY=sk-...          # For GPT models
```

### 3. Run development server

```bash
pnpm dev
```

Open [https://localhost:1455](https://localhost:1455) — the chat interface loads immediately.
By default, dev uses a self-signed localhost cert generated locally (no sudo required). Set `NO_SELF_SIGNED_CERT=1` to disable that default.
Generated certs are cached at `~/.ai-chat/dev-certs` (override with `DEV_GENERATED_CERT_DIR`) and regenerated automatically when expired.

---

## 📦 Architecture Decisions

### AI Framework: Vercel AI SDK (`ai` v4)

**Why:** After evaluating LangChain.js, LangGraph.js, Mastra, and the Vercel AI SDK:

| Framework | Weekly Downloads | TypeScript | Streaming | Tool Calling | Multi-Modal |
|-----------|-----------------|------------|-----------|--------------|-------------|
| **Vercel AI SDK** | ~4M | ✅ Excellent | ✅ Native | ✅ Native | ✅ Native |
| LangChain.js | ~800K | ✅ Good | ⚠ Adapter | ✅ Native | ⚠ Manual |
| LangGraph.js | ~150K | ✅ Good | ⚠ Complex | ✅ Native | ⚠ Manual |
| Mastra | ~10K | ✅ Good | ⚠ Limited | ✅ Native | ⚠ Manual |

The Vercel AI SDK's `streamText` + `toDataStreamResponse` pattern is purpose-built for this use case, has excellent TypeScript types, and integrates natively with Next.js App Router.

### UI Library: @assistant-ui/react

**Why:** Built specifically for the Vercel AI SDK. Key features:
- Native integration with `useChat` hook via `useVercelUseChatRuntime`
- Tool call visualization primitives
- TypeScript-first, well-maintained
- Composable (doesn't force opinions on styling)

### Other key choices:
- **pnpm** — faster installs, strict dependency management
- **Next.js 15 App Router** — streaming RSC, file-based routing, edge-compatible
- **Tailwind CSS** — utility-first, no runtime overhead
- **Zod** — schema validation for API requests

---

## 🧠 Context Management

The context manager (`lib/ai/context-manager.ts`) runs on every API request:

```
Request received
       │
       ▼
  Count tokens in messages + system prompt
       │
       ▼
  Used >= COMPACTION_THRESHOLD (default 75%)?
       │
     Yes │ No
       ▼   └──► Continue with original messages
  Apply compaction mode:
  - truncate: drop oldest messages
  - summary: AI summarize old history into one summary message
  - running-summary: maintain/update a rolling AI summary
       │
       ▼
  Reduce context toward COMPACTION_TARGET_RATIO
       │
       ▼
  Stream response with context metadata (wasCompacted/mode/tokensFreed)
```

**Configuration:**
```env
MAX_CONTEXT_TOKENS=150000      # Token budget
CONTEXT_COMPACTION_MODE=summary  # off | truncate | summary | running-summary
COMPACTION_THRESHOLD=0.75        # Start compacting at 75%
COMPACTION_TARGET_RATIO=0.10     # Compact down near 10%
KEEP_RECENT_MESSAGES=10          # Keep last N messages verbatim if possible
MIN_RECENT_MESSAGES=4            # Absolute minimum recent messages to keep
RUNNING_SUMMARY_THRESHOLD=0.35   # Extra trigger used by running-summary mode
```

### Tool Result Summarization

Large tool results are compacted before being added to context (configurable via Settings):

```env
TOOL_COMPACTION_MODE=summary          # off | summary | truncate
TOOL_COMPACTION_THRESHOLD=2000        # Token threshold
TOOL_COMPACTION_SUMMARY_MAX_TOKENS=1000
TOOL_COMPACTION_INPUT_MAX_CHARS=50000
TOOL_COMPACTION_TRUNCATE_MAX_CHARS=8000
```

The UI shows a ⚡ "Summarized" badge on tool calls whose results were condensed.

---

## 🔧 Adding Custom Tools

### 1. Define the tool (in `lib/tools/examples.ts` or a new file)

```typescript
import { tool } from 'ai'
import { z } from 'zod'

export const myCustomTool = tool({
  description: 'What this tool does',
  parameters: z.object({
    input: z.string().describe('The input parameter'),
  }),
  execute: async ({ input }) => {
    // Your tool logic here
    return { result: `Processed: ${input}` }
  },
})
```

### 2. Register it in the tool map

In `lib/tools/examples.ts`, add to `ALL_TOOLS`:

```typescript
export const ALL_TOOLS = {
  // ... existing tools
  myCustomTool,
}

export const TOOL_METADATA = {
  // ... existing metadata
  myCustomTool: {
    icon: '🛠',
    description: 'My custom tool',
    expectedDurationMs: 1000,
  },
}
```

### 3. The tool is automatically:
- Exposed to the LLM via the `/api/chat` route
- Tracked with state updates (pending → running → done)
- Listed in `/api/tools`
- Displayed with progress UI in the chat

---

## 📁 Project Structure

```
ai-chat/
├── app/
│   ├── api/
│   │   ├── chat/route.ts        # POST: streaming chat; GET: model list
│   │   └── tools/route.ts       # GET: available tools
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                 # Entry point → <ChatInterface />
├── components/
│   ├── chat/
│   │   ├── ChatInterface.tsx    # Main layout: header + messages + input
│   │   ├── MessageList.tsx      # Message bubbles, markdown, tool calls
│   │   ├── MessageInput.tsx     # Textarea + drag&drop + send/stop
│   │   ├── ToolCallProgress.tsx # Tool state: pending/running/done/error
│   │   └── FilePreview.tsx      # File thumbnail + attachment list
│   └── providers/
│       └── AIProvider.tsx       # @assistant-ui/react runtime wrapper
├── hooks/
│   ├── useChat.ts               # Extended Vercel AI SDK useChat
│   ├── useTokenCounter.ts       # Client-side token estimation
│   └── useFileUpload.ts         # File processing + base64 conversion
├── lib/
│   ├── ai/
│   │   ├── providers.ts         # Claude + OpenAI model factories
│   │   ├── tools.ts             # Tool bundle for API route
│   │   ├── context-manager.ts   # Token counting + conversation compaction
│   │   ├── summarizer.ts        # Tool result summarization
│   │   └── streaming.ts         # Stream annotation helpers
│   ├── tools/
│   │   ├── registry.ts          # ToolRegistry class with state tracking
│   │   └── examples.ts          # Built-in tools (calculator, web search, etc.)
│   ├── types.ts                 # Shared TypeScript interfaces
│   └── utils.ts                 # cn(), formatBytes(), formatTokens()
├── .env.example                 # Environment variable template
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

---

## 🌐 API Reference

### `POST /api/chat`

Streams a chat response.

**Request body:**
```json
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "systemPrompt": "You are a helpful assistant."
}
```

**Response headers:**
- `X-Context-Used` — estimated tokens used
- `X-Context-Limit` — configured token limit
- `X-Was-Compacted` — `"true"` if conversation was auto-compacted
- `X-Compaction-Configured-Mode` — active configured strategy (`off`, `truncate`, `summary`, `running-summary`)
- `X-Compaction-Threshold` — active configured threshold ratio
- `X-Compaction-Mode` — `truncate | summary | running-summary` when compacted
- `X-Compaction-Tokens-Freed` — estimated tokens removed by compaction

**Stream annotations (via Vercel AI SDK data protocol):**
```json
{ "type": "tool-state", "toolCallId": "...", "toolName": "webSearch", "state": "done", "resultSummarized": false }
{ "type": "context-stats", "used": 12000, "limit": 150000, "percentage": 0.08, "wasCompacted": false, "compactionMode": "summary", "tokensFreed": 9321 }
```

### `GET /api/chat`

Returns available models based on configured API keys.

### `GET /api/tools`

Returns tool definitions with metadata (name, description, icon, expectedDurationMs).

---

## 🔑 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `DEFAULT_PROVIDER` | `anthropic` | Active provider |
| `DEFAULT_MODEL` | `claude-sonnet-4-5` | Active model |
| `MAX_CONTEXT_TOKENS` | `150000` | Token budget |
| `CONTEXT_COMPACTION_MODE` | `summary` | Context strategy (`off`, `truncate`, `summary`, `running-summary`) |
| `COMPACTION_THRESHOLD` | `0.75` | Start compacting at this fraction |
| `COMPACTION_TARGET_RATIO` | `0.10` | Target fraction after compaction |
| `KEEP_RECENT_MESSAGES` | `10` | Messages kept verbatim during compaction |
| `MIN_RECENT_MESSAGES` | `4` | Minimum recent messages kept if still oversized |
| `RUNNING_SUMMARY_THRESHOLD` | `0.35` | Running-summary refresh threshold |
| `COMPACTION_SUMMARY_MAX_TOKENS` | `1200` | Max generated tokens for conversation summary |
| `COMPACTION_TRANSCRIPT_MAX_CHARS` | `120000` | Max chars sent to compaction summarizer |
| `TOOL_COMPACTION_MODE` | `summary` | Tool-result strategy (`off`, `summary`, `truncate`) |
| `TOOL_COMPACTION_THRESHOLD` | `2000` | Token threshold for tool compaction |
| `TOOL_COMPACTION_SUMMARY_MAX_TOKENS` | `1000` | Max generated tokens for tool-result summaries |
| `TOOL_COMPACTION_INPUT_MAX_CHARS` | `50000` | Max tool-output chars provided to summarizer |
| `TOOL_COMPACTION_TRUNCATE_MAX_CHARS` | `8000` | Max chars retained in truncate mode/fallback |
| `TOOL_RESULT_SUMMARY_THRESHOLD` | `2000` | Legacy alias for `TOOL_COMPACTION_THRESHOLD` |
| `NEXT_PUBLIC_APP_NAME` | `AI Chat` | App title shown in UI |
| `NO_SELF_SIGNED_CERT` | unset | Disable default self-signed HTTPS in `pnpm dev` (local cert generation) |
| `NO_HTTP_TO_HTTPS_REDIRECT` | unset | Disable default same-port HTTP->HTTPS redirect in `pnpm dev` |
| `DEV_HTTPS_KEY_FILE` | unset | Optional custom HTTPS key file path for `pnpm dev` |
| `DEV_HTTPS_CERT_FILE` | unset | Optional custom HTTPS cert file path for `pnpm dev` |
| `DEV_HTTPS_CA_FILE` | unset | Optional custom HTTPS CA file path for `pnpm dev` |
| `DEV_GENERATED_CERT_DIR` | `~/.ai-chat/dev-certs` | Cache dir for generated localhost cert/key; reused until expiry |

---

## 🛠 Development

```bash
pnpm dev          # Start dev server (https://localhost:1455)
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # ESLint
pnpm type-check   # TypeScript check
```

---

## 📄 License

MIT
