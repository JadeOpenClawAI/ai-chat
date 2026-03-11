/* eslint-disable max-len */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ALL_BUILTIN_TOOLS, BUILTIN_TOOL_METADATA } from '@/lib/tools/builtins';
import {
  createRuntimeManagementTools,
  RUNTIME_MANAGEMENT_TOOL_METADATA,
} from '@/lib/tools/builtins/runtime-management';

const execAsync = promisify(execCb);

export interface ToolMeta {
  icon?: string;
  description?: string;
  expectedDurationMs?: number;
  inputs?: string[];
  outputs?: string[];
  inputSchema?: unknown;
}

type PrimitiveType = 'string' | 'number' | 'boolean';
type ParamType = PrimitiveType | 'object' | 'array';

type RuntimeKind = 'javascript';

interface ParamField {
  type: ParamType;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  enum?: string[];
  additionalProperties?: unknown;
  items?: unknown;
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  additionalProperties?: unknown;
  items?: unknown;
}

interface JsonSchemaParams {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

type ToolParameters = Record<string, ParamField> | JsonSchemaParams;

interface RuntimeToolSpec {
  name: string;
  description: string;
  icon?: string;
  parameters: ToolParameters;
  // Explicit dependency version constraints, e.g. { "lodash": "^4.17.21" }.
  // When omitted or null, deps are auto-detected from code and installed at latest.
  dependencies?: Record<string, string> | null;
  runtime: {
    kind: RuntimeKind;
    code?: string;
    config?: Record<string, unknown>;
  };
}

function isJsonSchemaParams(params: ToolParameters): params is JsonSchemaParams {
  return (params as JsonSchemaParams).type === 'object' && typeof (params as JsonSchemaParams).properties === 'object';
}

function readJsonSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string') {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function normalizePropertyType(prop: JsonSchemaProperty): { type: ParamType; nullable: boolean } {
  const rawTypes = readJsonSchemaTypes(prop.type);
  const nullable = rawTypes.includes('null');
  const types = rawTypes.filter((entry) => entry !== 'null');

  if (types.includes('number')) {
    return { type: 'number', nullable };
  }
  if (types.includes('boolean')) {
    return { type: 'boolean', nullable };
  }
  if (types.includes('object')) {
    return { type: 'object', nullable };
  }
  if (types.includes('array')) {
    return { type: 'array', nullable };
  }
  if (types.includes('string')) {
    return { type: 'string', nullable };
  }

  // Unknown/missing JSON-schema types fall back to string for backward compatibility.
  return { type: 'string', nullable };
}

function normalizeParameters(params: ToolParameters): Record<string, ParamField> {
  if (!isJsonSchemaParams(params)) {
    return params;
  }
  const requiredSet = new Set(params.required ?? []);
  const result: Record<string, ParamField> = {};
  for (const [key, prop] of Object.entries(params.properties)) {
    const normalizedType = normalizePropertyType(prop);
    const type = normalizedType.type;
    result[key] = {
      type,
      ...(prop.description ? { description: prop.description } : {}),
      required: requiredSet.has(key),
      ...(normalizedType.nullable ? { nullable: true } : {}),
      ...(prop.enum?.length ? { enum: prop.enum } : {}),
      ...(type === 'object' && prop.additionalProperties !== undefined
        ? { additionalProperties: prop.additionalProperties }
        : {}),
      ...(type === 'array' && prop.items !== undefined
        ? { items: prop.items }
        : {}),
    };
  }
  return result;
}

const TOOLS_DIR = process.env.AI_CHAT_TOOLS_DIR || path.join(process.cwd(), 'runtime-tools');
const SPEC_FILENAME = 'spec.json';

function sanitizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

function buildParameterZodSchema(schema: ToolParameters) {
  const normalized = normalizeParameters(schema);
  const shape: Record<string, z.ZodTypeAny> = {};

  const zodFromJsonSchemaType = (type: unknown): z.ZodTypeAny => {
    if (type === 'number') {
      return z.number();
    }
    if (type === 'boolean') {
      return z.boolean();
    }
    return z.string();
  };

  for (const [key, field] of Object.entries(normalized)) {
    let base: z.ZodTypeAny;
    if (field.type === 'number') {
      base = z.number();
    } else if (field.type === 'boolean') {
      base = z.boolean();
    } else if (field.type === 'object') {
      const additionalType = (field.additionalProperties as { type?: unknown } | undefined)?.type;
      base = z.record(additionalType ? zodFromJsonSchemaType(additionalType) : z.unknown());
    } else if (field.type === 'array') {
      const itemType = (field.items as { type?: unknown } | undefined)?.type;
      base = z.array(itemType ? zodFromJsonSchemaType(itemType) : z.unknown());
    } else if (field.enum?.length) {
      base = z.enum(field.enum as [string, ...string[]]);
    } else {
      base = z.string();
    }

    if (field.nullable || !field.required) {
      base = z.union([base, z.null()]);
    }
    if (!field.required) {
      base = base.optional();
    }
    if (field.description) {
      base = base.describe(field.description);
    }
    shape[key] = base;
  }
  return z.object(shape);
}

function getRuntimeTemplate(): {
  parameters: Record<string, ParamField>;
  config: Record<string, unknown>;
  description: string;
  icon: string;
  code: string;
  } {
  return {
    parameters: {
      input: { type: 'string', description: 'Input string passed to your JS handler', required: false },
    },
    config: { timeoutMs: 30000 },
    description: 'Runs custom JavaScript/TypeScript handler code with full Node.js access.',
    icon: '🧠',
    code: `async ({ args }) => {
  const startedAt = Date.now();
  return {
    ok: true,
    receivedArgs: args ?? {},
    processedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt
  }
}`,
  };
}

// --------------- file-based execution helpers ---------------

const codeHashCache = new Map<string, string>();

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function rewriteImports(code: string, toolDir: string): string {
  const lines = code.split('\n');
  const imports: string[] = [];
  const rest: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^import\s+/.test(trimmed) && !trimmed.startsWith('import(')) {
      imports.push(trimmed);
    } else {
      rest.push(line);
    }
  }

  // Point createRequire at the per-tool directory so require() resolves from there
  const header = [
    'import { createRequire as __createRequire } from \'module\'',
    `const require = __createRequire(${JSON.stringify(path.join(toolDir, 'index.js'))})`,
    ...imports,
  ];

  const body = rest.join('\n').trim();

  return [...header, '', `export default ${body}`, ''].join('\n');
}

/**
 * Generate the IPC harness script that runs inside the child process.
 * Protocol (all messages are JSON over Node IPC):
 *   Parent -> Child:  { type: "invoke", args: { ... } }
 *   Child  -> Parent: { type: "result", data: <any> }
 *   Child  -> Parent: { type: "error", error: { message, stack?, code? } }
 */
function generateHarness(execPath: string): string {
  return [
    `import handler from ${JSON.stringify(execPath)};`,
    '',
    'process.on(\'message\', async (msg) => {',
    '  if (!msg || msg.type !== \'invoke\') return;',
    '  try {',
    '    const result = await handler({ args: msg.args });',
    '    process.send({ type: \'result\', data: result });',
    '  } catch (err) {',
    '    process.send({',
    '      type: \'error\',',
    '      error: {',
    '        message: err instanceof Error ? err.message : String(err),',
    '        stack: err instanceof Error ? err.stack : undefined,',
    '        code: err?.code,',
    '      },',
    '    });',
    '  }',
    '});',
    '',
    '// Signal ready',
    'process.send({ type: \'ready\' });',
    '',
  ].join('\n');
}

// --------------- auto-install deps ---------------

function extractPackageNames(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1]);
  }
  return [...names].filter(n =>
    !n.startsWith('.') &&
    !n.startsWith('/') &&
    !n.startsWith('node:') &&
    !isNodeBuiltin(n),
  );
}

function isNodeBuiltin(name: string): boolean {
  const builtins = new Set([
    'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
    'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path',
    'perf_hooks', 'querystring', 'readline', 'stream', 'string_decoder',
    'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
  ]);
  return builtins.has(name.split('/')[0]);
}

/**
 * Ensure a tool's npm dependencies are installed.
 * - Manual mode (explicitDeps provided): writes exact version constraints to package.json
 *   and installs only those. Missing packages are installed.
 * - Auto mode (explicitDeps is null/undefined): detects imports from code and installs
 *   any that are missing at latest.
 */
async function ensureToolDeps(code: string, toolDir: string, explicitDeps?: Record<string, string> | null) {
  const isManual = explicitDeps && Object.keys(explicitDeps).length > 0;

  // Determine which packages we need
  const packages = isManual
    ? Object.keys(explicitDeps)
    : extractPackageNames(code);
  if (!packages.length) {
    return;
  }

  await fs.mkdir(toolDir, { recursive: true });

  const pkgJsonPath = path.join(toolDir, 'package.json');

  if (isManual) {
    // Always write/overwrite package.json with the exact constraints
    await fs.writeFile(pkgJsonPath, JSON.stringify({
      name: 'ai-chat-runtime-tool',
      private: true,
      type: 'module',
      dependencies: explicitDeps,
    }, null, 2), 'utf8');
  } else {
    // Auto mode — create package.json if missing (no deps field, npm install will add them)
    try {
      await fs.access(pkgJsonPath);
    } catch {
      await fs.writeFile(pkgJsonPath, JSON.stringify({
        name: 'ai-chat-runtime-tool',
        private: true,
        type: 'module',
      }, null, 2), 'utf8');
    }
  }

  // Check which packages are missing from node_modules
  const missing: string[] = [];
  for (const pkg of packages) {
    const pkgDir = path.join(toolDir, 'node_modules', pkg.split('/')[0]);
    try {
      await fs.access(pkgDir);
    } catch {
      missing.push(pkg);
    }
  }

  if (!missing.length) {
    return;
  }

  if (isManual) {
    // For manual mode, npm install reads deps from package.json
    console.log(`[tools] installing deps for ${path.basename(toolDir)}: ${packages.join(', ')}`);
    await execAsync('npm install', { cwd: toolDir, timeout: 60000, shell: '/bin/bash' });
  } else {
    // For auto mode, install the bare package names at latest
    console.log(`[tools] auto-installing for ${path.basename(toolDir)}: ${missing.join(', ')}`);
    await execAsync(
      `npm install ${missing.join(' ')} --save`,
      { cwd: toolDir, timeout: 60000, shell: '/bin/bash' },
    );
  }
}

/**
 * Wipe a tool's node_modules and package-lock.json so deps are fully re-resolved
 * on next execution. Used by tool_editor in auto mode since deps may have
 * changed (added/removed imports, newer versions published).
 */
async function resetToolDeps(toolDir: string) {
  const nm = path.join(toolDir, 'node_modules');
  const lock = path.join(toolDir, 'package-lock.json');
  const pkg = path.join(toolDir, 'package.json');
  await fs.rm(nm, { recursive: true, force: true });
  await fs.rm(lock, { force: true });
  await fs.rm(pkg, { force: true });
}

// --------------- child-process execution ---------------

// Resolve the tsx binary from our project's node_modules/.bin at runtime.
// This avoids any webpack/Next.js static analysis issues with tsx/esbuild.
function getTsxBin(): string {
  return path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
}

interface ChildResult { type: 'result'; data: unknown }
interface ChildError { type: 'error'; error: { message: string; stack?: string; code?: string } }
interface ChildReady { type: 'ready' }
type ChildMessage = ChildResult | ChildError | ChildReady;

async function executeRuntimeSpec(spec: RuntimeToolSpec, args: Record<string, unknown>) {
  const src = spec.runtime.code?.trim();
  if (!src) {
    return { error: 'Missing runtime.code for javascript tool.' };
  }

  const safeName = sanitizeToolName(spec.name);
  const toolDir = getToolDir(safeName);
  const hash = simpleHash(src);
  const cachedHash = codeHashCache.get(safeName);

  // Rewrite exec file + harness when code changes
  if (hash !== cachedHash) {
    await ensureToolDeps(src, toolDir, spec.dependencies);
    await fs.mkdir(toolDir, { recursive: true });

    const execPath = path.join(toolDir, 'exec.ts');
    await fs.writeFile(execPath, rewriteImports(src, toolDir), 'utf8');

    const harnessPath = path.join(toolDir, 'harness.ts');
    await fs.writeFile(harnessPath, generateHarness(execPath), 'utf8');

    codeHashCache.set(safeName, hash);
  }

  const timeoutMs = Number(spec.runtime.config?.timeoutMs ?? 30000);
  const harnessPath = path.join(toolDir, 'harness.ts');

  return new Promise<Record<string, unknown>>((resolve) => {
    // Spawn tsx as the command with the harness as its argument.
    // stdio[3] = 'ipc' gives us a Node IPC channel for structured JSON messages,
    // while stdout/stderr remain available for the tool's own console output.
    const child = spawn(getTsxBin(), [harnessPath], {
      cwd: toolDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      timeout: timeoutMs,
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      finish({
        error: `Tool execution timed out after ${timeoutMs}ms`,
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
      });
    }, timeoutMs);

    function finish(result: Record<string, unknown>) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('message', (msg: ChildMessage) => {
      if (msg.type === 'ready') {
        child.send({ type: 'invoke', args });
      } else if (msg.type === 'result') {
        finish({ ok: true, result: msg.data, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      } else if (msg.type === 'error') {
        finish({ error: msg.error.message, stack: msg.error.stack, code: msg.error.code, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      }
    });

    child.on('error', (err) => {
      finish({ error: `Child process error: ${err.message}`, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        finish({
          error: signal
            ? `Child process killed by signal ${signal}`
            : `Child process exited with code ${code}`,
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
        });
      }
    });
  });
}

async function ensureToolsDir() {
  await fs.mkdir(TOOLS_DIR, { recursive: true });
}

function getToolDir(name: string) {
  return path.join(TOOLS_DIR, sanitizeToolName(name));
}

async function saveToolSpec(spec: RuntimeToolSpec, overwrite = false) {
  await ensureToolsDir();
  const safeName = sanitizeToolName(spec.name);
  if (!safeName) {
    throw new Error('Invalid tool name');
  }

  // Strip null dependencies so spec.json stays clean in auto mode
  const { dependencies, ...rest } = spec;
  const normalizedSpec: RuntimeToolSpec = {
    ...rest,
    name: safeName,
    ...(dependencies ? { dependencies } : {}),
  };
  const toolDir = getToolDir(safeName);
  const specPath = path.join(toolDir, SPEC_FILENAME);

  if (!overwrite) {
    try {
      await fs.access(specPath);
      throw new Error(`Tool already exists: ${safeName}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Tool already exists')) {
        throw err;
      }
    }
  }

  await fs.mkdir(toolDir, { recursive: true });
  await fs.writeFile(specPath, JSON.stringify(normalizedSpec, null, 2) + '\n', 'utf8');

  // Eagerly generate execution files so the tool dir is self-contained immediately
  const src = normalizedSpec.runtime.code?.trim();
  if (src) {
    await ensureToolDeps(src, toolDir, normalizedSpec.dependencies);

    const execPath = path.join(toolDir, 'exec.ts');
    await fs.writeFile(execPath, rewriteImports(src, toolDir), 'utf8');

    const harnessPath = path.join(toolDir, 'harness.ts');
    await fs.writeFile(harnessPath, generateHarness(execPath), 'utf8');

    codeHashCache.set(safeName, simpleHash(src));
  }

  return specPath;
}

async function loadRuntimeSpecs(): Promise<RuntimeToolSpec[]> {
  await ensureToolsDir();
  const entries = await fs.readdir(TOOLS_DIR, { withFileTypes: true });
  const specs: RuntimeToolSpec[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const specPath = path.join(TOOLS_DIR, entry.name, SPEC_FILENAME);
    try {
      const source = await fs.readFile(specPath, 'utf8');
      const spec = JSON.parse(source) as RuntimeToolSpec;
      if (!spec?.name || !spec?.runtime?.kind || !spec?.parameters) {
        continue;
      }
      specs.push(spec);
    } catch (err) {
      // Skip directories without a valid spec.json (or parse errors)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[tools] failed loading runtime tool', specPath, err);
      }
    }
  }

  return specs;
}

function createRuntimeTool(spec: RuntimeToolSpec) {
  return createTool({
    id: sanitizeToolName(spec.name),
    description: spec.description,
    inputSchema: buildParameterZodSchema(spec.parameters),
    execute: async (args) => {
      try {
        return await executeRuntimeSpec(spec, args as Record<string, unknown>);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

function parseParametersJson(text: string | null | undefined): ToolParameters | null {
  if (!text) {
    return null;
  }
  const parsed = JSON.parse(text) as ToolParameters;
  return parsed;
}

function createRuntimeManagementToolset() {
  return createRuntimeManagementTools({
    sanitizeToolName,
    parseParametersJson,
    getRuntimeTemplate,
    saveToolSpec,
    loadRuntimeSpecs,
    resetToolDeps,
    getToolDir,
    runtimeToolsDir: TOOLS_DIR,
    getReservedToolNames: () => new Set([
      ...Object.keys(ALL_BUILTIN_TOOLS),
      ...Object.keys(RUNTIME_MANAGEMENT_TOOL_METADATA),
    ]),
  });
}

export async function getRuntimeTools() {
  const runtimeSpecs = await loadRuntimeSpecs();
  const runtimeTools: Record<string, unknown> = {};
  const runtimeMeta: Record<string, ToolMeta> = {};

  for (const spec of runtimeSpecs) {
    const name = sanitizeToolName(spec.name);
    if (!name) {
      continue;
    }
    runtimeTools[name] = createRuntimeTool(spec);
    runtimeMeta[name] = {
      icon: spec.icon ?? '🧩',
      description: spec.description,
      expectedDurationMs: 1500,
      inputs: Object.entries(normalizeParameters(spec.parameters)).map(([k, v]) => `${k} (${v.type}${v.required ? '' : '?'})`),
      outputs: ['runtime result object', 'error (string?)'],
      inputSchema: spec.parameters,
    };
  }

  return { runtimeTools, runtimeMeta };
}

export async function getAllChatTools() {
  const runtimeManagementTools = createRuntimeManagementToolset();
  const { runtimeTools } = await getRuntimeTools();
  return { ...ALL_BUILTIN_TOOLS, ...runtimeManagementTools, ...runtimeTools };
}

export async function getAllToolMetadata(): Promise<Record<string, ToolMeta>> {
  const { runtimeMeta } = await getRuntimeTools();
  return {
    ...BUILTIN_TOOL_METADATA,
    ...RUNTIME_MANAGEMENT_TOOL_METADATA,
    ...runtimeMeta,
  };
}

export function getRuntimeToolsDirectory() {
  return TOOLS_DIR;
}
