import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

export const fileWriterTool = tool({
  description:
    'Writes text content to a server-side file path. Can overwrite, append, or replace a specific line range.',
  inputSchema: z.object({
    filename: z.string().describe('The name of the file to write'),
    content: z.string().describe('Text content to write'),
    mode: z.enum(['overwrite', 'append', 'replace-range']).default('overwrite')
      .describe('Write mode: overwrite entire file, append, or replace a line range.'),
    startLine: z.number().int().min(1).nullable().optional()
      .describe('Starting line number (1-indexed) for replace-range mode.'),
    endLine: z.number().int().min(1).nullable().optional()
      .describe('Ending line number (inclusive) for replace-range mode. Null means through EOF.'),
    createIfMissing: z.boolean().default(true)
      .describe('Create the file/directories if missing.'),
  }),
  execute: async ({ filename, content, mode, startLine, endLine, createIfMissing }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), filename);
      const parentDir = path.dirname(resolvedPath);
      if (createIfMissing) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      const hasExisting = await fs.access(resolvedPath).then(() => true).catch(() => false);
      if (!hasExisting && !createIfMissing) {
        return {
          ok: false,
          filename,
          resolvedPath,
          error: 'File does not exist and createIfMissing=false',
        };
      }

      if (mode === 'append') {
        await fs.appendFile(resolvedPath, content, 'utf8');
        const source = await fs.readFile(resolvedPath, 'utf8');
        return {
          ok: true,
          filename,
          resolvedPath,
          mode,
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          totalLines: source.split(/\r?\n/).length,
        };
      }

      if (mode === 'overwrite') {
        await fs.writeFile(resolvedPath, content, 'utf8');
        const source = await fs.readFile(resolvedPath, 'utf8');
        return {
          ok: true,
          filename,
          resolvedPath,
          mode,
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          totalLines: source.split(/\r?\n/).length,
        };
      }

      if (startLine === null || startLine === undefined) {
        return {
          ok: false,
          filename,
          resolvedPath,
          mode,
          error: 'startLine is required for replace-range mode',
        };
      }

      const current = hasExisting ? await fs.readFile(resolvedPath, 'utf8') : '';
      const lines = current.length > 0 ? current.split(/\r?\n/) : [];
      const from = Math.max(1, Math.floor(startLine));
      const to = endLine === null || endLine === undefined
        ? Math.max(from, lines.length)
        : Math.max(from, Math.floor(endLine));
      const replacement = content.split(/\r?\n/);

      const startIdx = from - 1;
      const endExclusive = to;
      const before = lines.slice(0, startIdx);
      const after = lines.slice(Math.max(0, endExclusive));
      const nextLines = [...before, ...replacement, ...after];
      const next = nextLines.join('\n');

      await fs.writeFile(resolvedPath, next, 'utf8');

      return {
        ok: true,
        filename,
        resolvedPath,
        mode,
        bytesWritten: Buffer.byteLength(next, 'utf8'),
        replacedLines: {
          from,
          to,
          insertedLineCount: replacement.length,
        },
        totalLines: nextLines.length,
      };
    } catch (err) {
      return {
        ok: false,
        filename,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export const fileWriterToolMetadata: BuiltinToolMetadata = {
  icon: '✍️',
  description: 'File writer with overwrite/append/line-range replacement modes.',
  expectedDurationMs: 300,
  inputs: ['filename (string)', 'content (string)', 'mode?', 'startLine?', 'endLine?', 'createIfMissing?'],
  outputs: ['ok', 'resolvedPath', 'bytesWritten', 'totalLines', 'replacedLines?', 'error?'],
};
