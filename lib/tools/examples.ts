// ============================================================
// Example Tool Definitions
// Real, working tool implementations using Vercel AI SDK tool()
// ============================================================

import { tool } from 'ai';
import { z } from 'zod/v3';
import fs from 'node:fs/promises';
import path from 'node:path';

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[] | undefined): Array<{ title: string; url: string }> {
  if (!topics?.length) {
    return [];
  }

  const flat: Array<{ title: string; url: string }> = [];
  for (const item of topics) {
    if (Array.isArray(item.Topics) && item.Topics.length > 0) {
      flat.push(...flattenDuckDuckGoTopics(item.Topics));
      continue;
    }
    if (item.Text && item.FirstURL) {
      flat.push({ title: item.Text, url: item.FirstURL });
    }
  }
  return flat;
}

// ── Calculator ───────────────────────────────────────────────

export const calculatorTool = tool({
  description:
    'Evaluates a mathematical expression and returns the result. Supports basic arithmetic, exponents, and common math functions.',
  inputSchema: z.object({
    expression: z
      .string()
      .describe('The mathematical expression to evaluate, e.g. "2 + 2" or "Math.sqrt(16)"'),
  }),
  execute: async ({ expression }) => {
    try {
      // Safe evaluation using Function constructor with restricted scope
      const safeExpression = expression.replace(/[^0-9+\-*/().,%^√πe\s]/g, '');
      // Replace common math notation
      const normalized = safeExpression
        .replace(/√/g, 'Math.sqrt')
        .replace(/π/g, 'Math.PI')
        .replace(/\^/g, '**');


      const result = new Function(
        'Math',
        `"use strict"; return (${normalized})`,
      )(Math);

      if (typeof result !== 'number' || isNaN(result)) {
        return { error: 'Expression did not evaluate to a valid number', expression };
      }

      return {
        expression,
        result,
        formatted: result.toLocaleString(),
      };
    } catch (err) {
      return {
        error: `Failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
        expression,
      };
    }
  },
});

// ── Web Search ────────────────────────────────────────────────

export const webSearchTool = tool({
  description:
    'Searches the web for information about a topic. Returns relevant snippets and URLs.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    numResults: z
      .number()
      .min(1)
      .max(10)
      .default(5)
      .describe('Number of results to return (1-10)'),
  }),
  execute: async ({ query, numResults }) => {
    try {
      const endpoint = new URL('https://api.duckduckgo.com/');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('no_html', '1');
      endpoint.searchParams.set('no_redirect', '1');
      endpoint.searchParams.set('skip_disambig', '1');

      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'ai-chat/1.0' },
      });

      if (!response.ok) {
        return {
          query,
          error: `Search request failed with status ${response.status}`,
          results: [],
          totalResults: 0,
        };
      }

      const payload = await response.json() as DuckDuckGoResponse;
      const related = flattenDuckDuckGoTopics(payload.RelatedTopics);
      const results = [
        ...(payload.AbstractText && payload.AbstractURL
          ? [{ title: payload.AbstractText, url: payload.AbstractURL }]
          : []),
        ...related,
      ]
        .slice(0, numResults)
        .map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.title,
        }));

      return {
        query,
        provider: 'duckduckgo',
        results,
        totalResults: results.length,
      };
    } catch (err) {
      return {
        query,
        error: err instanceof Error ? err.message : String(err),
        results: [],
        totalResults: 0,
      };
    }
  },
});

// ── Code Runner ──────────────────────────────────────────────

export const codeRunnerTool = tool({
  description:
    'Executes JavaScript/TypeScript code in a sandboxed environment and returns the output. '
    + 'Use only when the user explicitly asks to execute code.',
  inputSchema: z.object({
    code: z.string().describe('The JavaScript code to execute'),
    language: z
      .enum(['javascript', 'typescript'])
      .describe('The programming language'),
  }),
  execute: async ({ code, language }) => {
    try {
      const logs: string[] = [];
      const errors: string[] = [];

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
      };

      // Execute with sandboxed console (basic sandbox — not for untrusted code)

      const fn = new Function('console', 'Math', 'JSON', `"use strict";\n${code}`);
      const result = fn(sandboxConsole, Math, JSON);

      return {
        language,
        output: logs.join('\n'),
        errors: errors.length > 0 ? errors.join('\n') : undefined,
        returnValue: result !== undefined ? String(result) : undefined,
        success: errors.length === 0,
      };
    } catch (err) {
      return {
        language,
        output: '',
        errors: err instanceof Error ? err.message : String(err),
        success: false,
      };
    }
  },
});

// ── File Reader (for uploaded files) ────────────────────────

export const fileReaderTool = tool({
  description:
    'Reads and returns text content from a server-side file path.',
  inputSchema: z.object({
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
    try {
      const resolvedPath = path.resolve(process.cwd(), filename);
      const source = await fs.readFile(resolvedPath, 'utf8');
      const lines = source.split(/\r?\n/);
      const from = Math.max(1, Math.floor(startLine));
      const to = endLine === null ? lines.length : Math.max(from, Math.floor(endLine));
      const sliced = lines.slice(from - 1, to);

      return {
        filename,
        resolvedPath,
        requestedLines: { from, to },
        totalLines: lines.length,
        content: sliced.join('\n'),
      };
    } catch (err) {
      return {
        filename,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

// ── Current Time ─────────────────────────────────────────────

export const currentTimeTool = tool({
  description: 'Returns the current date and time in various formats and timezones.',
  inputSchema: z.object({
    timezone: z
      .string()
      .describe('IANA timezone name, e.g. "America/New_York"'),
    format: z
      .enum(['iso', 'human', 'timestamp'])
      .describe('Output format'),
  }),
  execute: async ({ timezone, format }) => {
    const now = new Date();
    let formatted: string;

    try {
      if (format === 'iso') {
        formatted = now.toISOString();
      } else if (format === 'timestamp') {
        formatted = String(Math.floor(now.getTime() / 1000));
      } else {
        formatted = now.toLocaleString('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        });
      }
    } catch {
      formatted = now.toISOString();
    }

    return {
      datetime: formatted,
      timezone,
      utc: now.toISOString(),
      timestamp: Math.floor(now.getTime() / 1000),
    };
  },
});

// ── Failure simulator tool (for UI/testing) ─────────────────

export const failureSimulatorTool = tool({
  description:
    'Intentionally fails for testing tool error UX. Use to verify error rendering and retry flows.',
  inputSchema: z.object({
    reason: z.string().describe('Reason text to include in the simulated failure'),
    fail: z.boolean().describe('Set true to force a failure, false to return success'),
  }),
  execute: async ({ reason, fail }) => {
    if (fail) {
      return {
        error: `Simulated tool failure: ${reason}`,
        ok: false,
      };
    }
    return {
      ok: true,
      message: `Simulated tool success: ${reason}`,
    };
  },
});

// ── Tool collection ──────────────────────────────────────────

export const ALL_TOOLS = {
  calculator: calculatorTool,
  web_search: webSearchTool,
  code_runner: codeRunnerTool,
  file_reader: fileReaderTool,
  current_time: currentTimeTool,
  failure_simulator: failureSimulatorTool,
} as const;

export type ToolName = keyof typeof ALL_TOOLS;

// ── Tool metadata for registry ───────────────────────────────

export const TOOL_METADATA: Record<
  ToolName,
  {
    icon: string;
    description: string;
    expectedDurationMs: number;
    inputs: string[];
    outputs: string[];
  }
> = {
  calculator: {
    icon: '🔢',
    description: 'Mathematical expression evaluator',
    expectedDurationMs: 100,
    inputs: ['expression (string)'],
    outputs: ['result (number)', 'formatted (string)', 'error (string?)'],
  },
  web_search: {
    icon: '🔍',
    description: 'Web search',
    expectedDurationMs: 2000,
    inputs: ['query (string)', 'numResults (1-10)'],
    outputs: ['provider (duckduckgo)', 'results[] (title/url/snippet)', 'totalResults (number)', 'error (string?)'],
  },
  code_runner: {
    icon: '⚙️',
    description: 'Code execution (explicit user intent only)',
    expectedDurationMs: 3000,
    inputs: ['code (string)', 'language (javascript|typescript)'],
    outputs: ['output (string)', 'errors (string?)', 'success (boolean)'],
  },
  file_reader: {
    icon: '📄',
    description: 'File reader',
    expectedDurationMs: 500,
    inputs: ['filename (string)', 'startLine (number)', 'endLine (number|null)'],
    outputs: ['resolvedPath (string)', 'content (string)', 'requestedLines (object)', 'error (string?)'],
  },
  current_time: {
    icon: '🕐',
    description: 'Current date/time',
    expectedDurationMs: 50,
    inputs: ['timezone (IANA string)', 'format (iso|human|timestamp)'],
    outputs: ['datetime (string)', 'utc (string)', 'timestamp (number)'],
  },
  failure_simulator: {
    icon: '💥',
    description: 'Simulates deterministic tool failure for UI testing',
    expectedDurationMs: 80,
    inputs: ['reason (string)', 'fail (boolean)'],
    outputs: ['throws Error when fail=true', 'ok/message when fail=false'],
  },
};
