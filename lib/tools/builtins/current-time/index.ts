import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

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

export const currentTimeToolMetadata: BuiltinToolMetadata = {
  icon: '🕰️',
  description: 'Current date/time',
  expectedDurationMs: 50,
  inputs: ['timezone (IANA string)', 'format (iso|human|timestamp)'],
  outputs: ['datetime (string)', 'utc (string)', 'timestamp (number)'],
};
