import { spawn } from 'node:child_process';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

interface RunCliError {
  message: string;
  code: string | number | null;
  signal: string | null;
}

interface RunCliResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error: RunCliError | null;
}

export const runCliTool = createTool({
  id: 'run_cli',
  description: 'Run a CLI command on the server and return exit code, stdout, and stderr. Supports optional working directory and timeout.',
  inputSchema: z.object({
    command: z.string().describe('Shell command to run'),
    cwd: z.union([z.string(), z.null()]).optional().describe('Working directory'),
    timeoutMs: z.union([z.number(), z.null()]).optional().describe('Timeout in milliseconds'),
  }),
  execute: async ({ command, cwd, timeoutMs }) => {
    return await new Promise<RunCliResult>((resolve) => {
      const normalizedTimeoutMs = Number(timeoutMs ?? 30000);
      const timeout = Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0
        ? normalizedTimeoutMs
        : 30000;

      const child = spawn('/bin/bash', ['-lc', String(command)], {
        cwd: cwd ?? undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (payload: Pick<RunCliResult, 'ok' | 'exitCode' | 'error'>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          ...payload,
          timedOut,
          stdout,
          stderr,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 500);
        finish({
          ok: false,
          exitCode: null,
          error: {
            message: `Command timed out after ${timeout}ms`,
            code: 'ETIMEDOUT',
            signal: 'SIGTERM',
          },
        });
      }, timeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
      });

      child.on('error', (error) => {
        const errno = error as NodeJS.ErrnoException;
        finish({
          ok: false,
          exitCode: null,
          error: {
            message: error.message,
            code: typeof errno.code === 'string' || typeof errno.code === 'number' ? errno.code : null,
            signal: null,
          },
        });
      });

      child.on('close', (code, signal) => {
        if (timedOut) {
          return;
        }
        finish({
          ok: code === 0,
          exitCode: typeof code === 'number' ? code : null,
          error: code === 0
            ? null
            : {
              message: signal
                ? `Command terminated by signal ${signal}`
                : `Command exited with code ${String(code)}`,
              code,
              signal: signal ?? null,
            },
        });
      });
    });
  },
});

export const runCliToolMetadata: BuiltinToolMetadata = {
  icon: '🖥️',
  description: 'Run a shell command on the server with optional cwd and timeout.',
  expectedDurationMs: 1000,
  inputs: ['command (string)', 'cwd? (string|null)', 'timeoutMs? (number|null)'],
  outputs: ['ok', 'exitCode', 'timedOut', 'stdout', 'stderr', 'error?'],
};
