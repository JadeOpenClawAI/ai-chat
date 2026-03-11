import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

export const codeRunnerTool = createTool({
  id: 'code_runner',
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

export const codeRunnerToolMetadata: BuiltinToolMetadata = {
  icon: '🧪',
  description: 'Code execution (explicit user intent only)',
  expectedDurationMs: 3000,
  inputs: ['code (string)', 'language (javascript|typescript)'],
  outputs: ['output (string)', 'errors (string?)', 'success (boolean)'],
};
