import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

export const fileReaderTool = createTool({
  id: 'file_reader',
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

export const fileReaderToolMetadata: BuiltinToolMetadata = {
  icon: '📖',
  description: 'File reader',
  expectedDurationMs: 500,
  inputs: ['filename (string)', 'startLine (number)', 'endLine (number|null)'],
  outputs: ['resolvedPath (string)', 'content (string)', 'requestedLines (object)', 'error (string?)'],
};
