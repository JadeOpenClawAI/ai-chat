import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

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
      const safeExpression = expression.replace(/[^0-9+\-*/().,%^√πe\s]/g, '');
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

export const calculatorToolMetadata: BuiltinToolMetadata = {
  icon: '🧮',
  description: 'Mathematical expression evaluator',
  expectedDurationMs: 100,
  inputs: ['expression (string)'],
  outputs: ['result (number)', 'formatted (string)', 'error (string?)'],
};
