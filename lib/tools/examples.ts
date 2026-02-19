// ============================================================
// Example Tool Definitions
// Real, working tool implementations using Vercel AI SDK tool()
// ============================================================

import { tool } from 'ai'
import { z } from 'zod'

// ── Calculator ───────────────────────────────────────────────

export const calculatorTool = tool({
  description:
    'Evaluates a mathematical expression and returns the result. Supports basic arithmetic, exponents, and common math functions.',
  parameters: z.object({
    expression: z
      .string()
      .describe('The mathematical expression to evaluate, e.g. "2 + 2" or "Math.sqrt(16)"'),
  }),
  execute: async ({ expression }) => {
    try {
      // Safe evaluation using Function constructor with restricted scope
      const safeExpression = expression.replace(/[^0-9+\-*/().,%^√πe\s]/g, '')
      // Replace common math notation
      const normalized = safeExpression
        .replace(/√/g, 'Math.sqrt')
        .replace(/π/g, 'Math.PI')
        .replace(/\^/g, '**')

      // eslint-disable-next-line no-new-func
      const result = new Function(
        'Math',
        `"use strict"; return (${normalized})`,
      )(Math)

      if (typeof result !== 'number' || isNaN(result)) {
        return { error: 'Expression did not evaluate to a valid number', expression }
      }

      return {
        expression,
        result,
        formatted: result.toLocaleString(),
      }
    } catch (err) {
      return {
        error: `Failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
        expression,
      }
    }
  },
})

// ── Web Search (mock — replace with real API) ────────────────

export const webSearchTool = tool({
  description:
    'Searches the web for information about a topic. Returns relevant snippets and URLs.',
  parameters: z.object({
    query: z.string().describe('The search query'),
    numResults: z
      .number()
      .min(1)
      .max(10)
      .describe('Number of results to return (1-10)'),
  }),
  execute: async ({ query, numResults }) => {
    // In production, integrate with Brave Search, Tavily, Serper, or similar
    // This mock returns structured placeholder results
    const mockResults = Array.from({ length: numResults }, (_, i) => ({
      title: `Result ${i + 1} for "${query}"`,
      url: `https://example.com/result-${i + 1}`,
      snippet: `This is a relevant snippet about "${query}" from result ${i + 1}. ` +
        `It contains useful information that would help answer the user's question.`,
      publishedAt: new Date(Date.now() - i * 86400000).toISOString(),
    }))

    return {
      query,
      results: mockResults,
      totalResults: mockResults.length,
      note: 'This is a mock search result. Integrate with a real search API for production use.',
    }
  },
})

// ── Code Runner ──────────────────────────────────────────────

export const codeRunnerTool = tool({
  description:
    'Executes JavaScript/TypeScript code in a sandboxed environment and returns the output.',
  parameters: z.object({
    code: z.string().describe('The JavaScript code to execute'),
    language: z
      .enum(['javascript', 'typescript'])
      .describe('The programming language'),
  }),
  execute: async ({ code, language }) => {
    try {
      const logs: string[] = []
      const errors: string[] = []

      // Create a sandboxed console
      const sandboxConsole = {
        log: (...args: unknown[]) =>
          logs.push(args.map((a) => JSON.stringify(a)).join(' ')),
        error: (...args: unknown[]) =>
          errors.push(args.map((a) => JSON.stringify(a)).join(' ')),
        warn: (...args: unknown[]) =>
          logs.push('[warn] ' + args.map((a) => JSON.stringify(a)).join(' ')),
        info: (...args: unknown[]) =>
          logs.push('[info] ' + args.map((a) => JSON.stringify(a)).join(' ')),
      }

      // Execute with sandboxed console (basic sandbox — not for untrusted code)
      // eslint-disable-next-line no-new-func
      const fn = new Function('console', 'Math', 'JSON', `"use strict";\n${code}`)
      const result = fn(sandboxConsole, Math, JSON)

      return {
        language,
        output: logs.join('\n'),
        errors: errors.length > 0 ? errors.join('\n') : undefined,
        returnValue: result !== undefined ? String(result) : undefined,
        success: errors.length === 0,
      }
    } catch (err) {
      return {
        language,
        output: '',
        errors: err instanceof Error ? err.message : String(err),
        success: false,
      }
    }
  },
})

// ── File Reader (for uploaded files) ────────────────────────

export const fileReaderTool = tool({
  description:
    'Reads and returns the content of a file that has been uploaded in the conversation.',
  parameters: z.object({
    filename: z.string().describe('The name of the file to read'),
    startLine: z
      .number()
      .describe('Starting line number (1-indexed)'),
    endLine: z
      .number()
      .nullable()
      .describe('Ending line number (inclusive). Use null to read to end.'),
  }),
  execute: async ({ filename, startLine, endLine }) => {
    // In production, this would retrieve the file from your upload store
    // For now, return a structured response indicating the file info
    return {
      filename,
      note: `File "${filename}" would be read here. In production, integrate with your file storage.`,
      requestedLines: { from: startLine, to: endLine ?? 'end' },
      content: `// File content for ${filename} would appear here`,
    }
  },
})

// ── Current Time ─────────────────────────────────────────────

export const currentTimeTool = tool({
  description: 'Returns the current date and time in various formats and timezones.',
  parameters: z.object({
    timezone: z
      .string()
      .describe('IANA timezone name, e.g. "America/New_York"'),
    format: z
      .enum(['iso', 'human', 'timestamp'])
      .describe('Output format'),
  }),
  execute: async ({ timezone, format }) => {
    const now = new Date()
    let formatted: string

    try {
      if (format === 'iso') {
        formatted = now.toISOString()
      } else if (format === 'timestamp') {
        formatted = String(Math.floor(now.getTime() / 1000))
      } else {
        formatted = now.toLocaleString('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        })
      }
    } catch {
      formatted = now.toISOString()
    }

    return {
      datetime: formatted,
      timezone,
      utc: now.toISOString(),
      timestamp: Math.floor(now.getTime() / 1000),
    }
  },
})

// ── Failure simulator tool (for UI/testing) ─────────────────

export const failureSimulatorTool = tool({
  description:
    'Intentionally fails for testing tool error UX. Use to verify error rendering and retry flows.',
  parameters: z.object({
    reason: z.string().describe('Reason text to include in the simulated failure'),
    fail: z.boolean().describe('Set true to force a failure, false to return success'),
  }),
  execute: async ({ reason, fail }) => {
    if (fail) {
      throw new Error(`Simulated tool failure: ${reason}`)
    }
    return {
      ok: true,
      message: `Simulated tool success: ${reason}`,
    }
  },
})

// ── Tool collection ──────────────────────────────────────────

export const ALL_TOOLS = {
  calculator: calculatorTool,
  webSearch: webSearchTool,
  codeRunner: codeRunnerTool,
  fileReader: fileReaderTool,
  currentTime: currentTimeTool,
  failureSimulator: failureSimulatorTool,
} as const

export type ToolName = keyof typeof ALL_TOOLS

// ── Tool metadata for registry ───────────────────────────────

export const TOOL_METADATA: Record<
  ToolName,
  {
    icon: string
    description: string
    expectedDurationMs: number
    inputs: string[]
    outputs: string[]
  }
> = {
  calculator: {
    icon: '🔢',
    description: 'Mathematical expression evaluator',
    expectedDurationMs: 100,
    inputs: ['expression (string)'],
    outputs: ['result (number)', 'formatted (string)', 'error (string?)'],
  },
  webSearch: {
    icon: '🔍',
    description: 'Web search',
    expectedDurationMs: 2000,
    inputs: ['query (string)', 'numResults (1-10)'],
    outputs: ['results[] (title/url/snippet)', 'totalResults (number)'],
  },
  codeRunner: {
    icon: '⚙️',
    description: 'Code execution',
    expectedDurationMs: 3000,
    inputs: ['code (string)', 'language (javascript|typescript)'],
    outputs: ['output (string)', 'errors (string?)', 'success (boolean)'],
  },
  fileReader: {
    icon: '📄',
    description: 'File reader',
    expectedDurationMs: 500,
    inputs: ['filename (string)', 'startLine (number)', 'endLine (number|null)'],
    outputs: ['content (string)', 'requestedLines (object)'],
  },
  currentTime: {
    icon: '🕐',
    description: 'Current date/time',
    expectedDurationMs: 50,
    inputs: ['timezone (IANA string)', 'format (iso|human|timestamp)'],
    outputs: ['datetime (string)', 'utc (string)', 'timestamp (number)'],
  },
  failureSimulator: {
    icon: '💥',
    description: 'Simulates deterministic tool failure for UI testing',
    expectedDurationMs: 80,
    inputs: ['reason (string)', 'fail (boolean)'],
    outputs: ['throws Error when fail=true', 'ok/message when fail=false'],
  },
}
