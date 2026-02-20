import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { exec as execCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { ALL_TOOLS as EXAMPLE_TOOLS, TOOL_METADATA as EXAMPLE_TOOL_METADATA } from '@/lib/tools/examples'

const execAsync = promisify(execCb)

export interface ToolMeta {
  icon?: string
  description?: string
  expectedDurationMs?: number
  inputs?: string[]
  outputs?: string[]
}

type PrimitiveType = 'string' | 'number' | 'boolean'

type RuntimeKind = 'javascript'

interface ParamField {
  type: PrimitiveType
  description?: string
  required?: boolean
  enum?: string[]
}

interface JsonSchemaParams {
  type: 'object'
  properties: Record<string, { type?: string; description?: string; enum?: string[]; additionalProperties?: unknown }>
  required?: string[]
}

type ToolParameters = Record<string, ParamField> | JsonSchemaParams

interface RuntimeToolSpec {
  name: string
  description: string
  icon?: string
  parameters: ToolParameters
  // Explicit dependency version constraints, e.g. { "lodash": "^4.17.21" }.
  // When omitted or null, deps are auto-detected from code and installed at latest.
  dependencies?: Record<string, string> | null
  runtime: {
    kind: RuntimeKind
    code?: string
    config?: Record<string, unknown>
  }
}

function isJsonSchemaParams(params: ToolParameters): params is JsonSchemaParams {
  return (params as JsonSchemaParams).type === 'object' && typeof (params as JsonSchemaParams).properties === 'object'
}

function normalizeParameters(params: ToolParameters): Record<string, ParamField> {
  if (!isJsonSchemaParams(params)) return params
  const requiredSet = new Set(params.required ?? [])
  const result: Record<string, ParamField> = {}
  for (const [key, prop] of Object.entries(params.properties)) {
    const primitiveType = (prop.type === 'number' || prop.type === 'boolean') ? prop.type : 'string' as PrimitiveType
    result[key] = {
      type: primitiveType,
      ...(prop.description ? { description: prop.description } : {}),
      required: requiredSet.has(key),
      ...(prop.enum?.length ? { enum: prop.enum } : {}),
    }
  }
  return result
}

const TOOLS_DIR = process.env.AI_CHAT_TOOLS_DIR || path.join(process.cwd(), 'runtime-tools')
const SPEC_FILENAME = 'spec.json'

function sanitizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
}

function buildParameterZodSchema(schema: ToolParameters) {
  const normalized = normalizeParameters(schema)
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, field] of Object.entries(normalized)) {
    let base: z.ZodTypeAny
    if (field.type === 'number') base = z.number()
    else if (field.type === 'boolean') base = z.boolean()
    else if (field.enum?.length) base = z.enum(field.enum as [string, ...string[]])
    else base = z.string()

    if (!field.required) base = z.union([base, z.null()])
    if (field.description) base = base.describe(field.description)
    shape[key] = base
  }
  return z.object(shape)
}

function getRuntimeTemplate(): {
  parameters: Record<string, ParamField>
  config: Record<string, unknown>
  description: string
  icon: string
  code: string
} {
  return {
    parameters: {
      input: { type: 'string', description: 'Input string passed to your JS handler', required: false },
    },
    config: { timeoutMs: 30000 },
    description: 'Runs custom JavaScript/TypeScript handler code with full Node.js access.',
    icon: '🧠',
    code: `async ({ args }) => {
  return {
    ok: true,
    note: 'Replace this code in tool_editor/tool_builder',
    args
  }
}`,
  }
}

// --------------- file-based execution helpers ---------------

const codeHashCache = new Map<string, string>()

function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

function rewriteImports(code: string, toolDir: string): string {
  const lines = code.split('\n')
  const imports: string[] = []
  const rest: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^import\s+/.test(trimmed) && !trimmed.startsWith('import(')) {
      imports.push(trimmed)
    } else {
      rest.push(line)
    }
  }

  // Point createRequire at the per-tool directory so require() resolves from there
  const header = [
    `import { createRequire as __createRequire } from 'module'`,
    `const require = __createRequire(${JSON.stringify(path.join(toolDir, 'index.js'))})`,
    ...imports,
  ]

  const body = rest.join('\n').trim()

  return [...header, '', `export default ${body}`, ''].join('\n')
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
    ``,
    `process.on('message', async (msg) => {`,
    `  if (!msg || msg.type !== 'invoke') return;`,
    `  try {`,
    `    const result = await handler({ args: msg.args });`,
    `    process.send({ type: 'result', data: result });`,
    `  } catch (err) {`,
    `    process.send({`,
    `      type: 'error',`,
    `      error: {`,
    `        message: err instanceof Error ? err.message : String(err),`,
    `        stack: err instanceof Error ? err.stack : undefined,`,
    `        code: err?.code,`,
    `      },`,
    `    });`,
    `  }`,
    `});`,
    ``,
    `// Signal ready`,
    `process.send({ type: 'ready' });`,
    ``,
  ].join('\n')
}

// --------------- auto-install deps ---------------

function extractPackageNames(code: string): string[] {
  const names = new Set<string>()
  for (const m of code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1])
  }
  for (const m of code.matchAll(/import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    names.add(m[1])
  }
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    names.add(m[1])
  }
  return [...names].filter(n =>
    !n.startsWith('.') &&
    !n.startsWith('/') &&
    !n.startsWith('node:') &&
    !isNodeBuiltin(n)
  )
}

function isNodeBuiltin(name: string): boolean {
  const builtins = new Set([
    'assert','buffer','child_process','cluster','crypto','dgram','dns',
    'events','fs','http','http2','https','module','net','os','path',
    'perf_hooks','querystring','readline','stream','string_decoder',
    'timers','tls','tty','url','util','v8','vm','worker_threads','zlib',
  ])
  return builtins.has(name.split('/')[0])
}

/**
 * Ensure a tool's npm dependencies are installed.
 * - Manual mode (explicitDeps provided): writes exact version constraints to package.json
 *   and installs only those. Missing packages are installed.
 * - Auto mode (explicitDeps is null/undefined): detects imports from code and installs
 *   any that are missing at latest.
 */
async function ensureToolDeps(code: string, toolDir: string, explicitDeps?: Record<string, string> | null) {
  const isManual = explicitDeps && Object.keys(explicitDeps).length > 0

  // Determine which packages we need
  const packages = isManual
    ? Object.keys(explicitDeps)
    : extractPackageNames(code)
  if (!packages.length) return

  await fs.mkdir(toolDir, { recursive: true })

  const pkgJsonPath = path.join(toolDir, 'package.json')

  if (isManual) {
    // Always write/overwrite package.json with the exact constraints
    await fs.writeFile(pkgJsonPath, JSON.stringify({
      name: 'ai-chat-runtime-tool',
      private: true,
      type: 'module',
      dependencies: explicitDeps,
    }, null, 2), 'utf8')
  } else {
    // Auto mode — create package.json if missing (no deps field, npm install will add them)
    try {
      await fs.access(pkgJsonPath)
    } catch {
      await fs.writeFile(pkgJsonPath, JSON.stringify({
        name: 'ai-chat-runtime-tool',
        private: true,
        type: 'module',
      }, null, 2), 'utf8')
    }
  }

  // Check which packages are missing from node_modules
  const missing: string[] = []
  for (const pkg of packages) {
    const pkgDir = path.join(toolDir, 'node_modules', pkg.split('/')[0])
    try {
      await fs.access(pkgDir)
    } catch {
      missing.push(pkg)
    }
  }

  if (!missing.length) return

  if (isManual) {
    // For manual mode, npm install reads deps from package.json
    console.log(`[tools] installing deps for ${path.basename(toolDir)}: ${packages.join(', ')}`)
    await execAsync('npm install', { cwd: toolDir, timeout: 60000, shell: '/bin/bash' })
  } else {
    // For auto mode, install the bare package names at latest
    console.log(`[tools] auto-installing for ${path.basename(toolDir)}: ${missing.join(', ')}`)
    await execAsync(
      `npm install ${missing.join(' ')} --save`,
      { cwd: toolDir, timeout: 60000, shell: '/bin/bash' }
    )
  }
}

/**
 * Wipe a tool's node_modules and package-lock.json so deps are fully re-resolved
 * on next execution. Used by tool_editor in auto mode since deps may have
 * changed (added/removed imports, newer versions published).
 */
async function resetToolDeps(toolDir: string) {
  const nm = path.join(toolDir, 'node_modules')
  const lock = path.join(toolDir, 'package-lock.json')
  const pkg = path.join(toolDir, 'package.json')
  await fs.rm(nm, { recursive: true, force: true })
  await fs.rm(lock, { force: true })
  await fs.rm(pkg, { force: true })
}

// --------------- child-process execution ---------------

// Resolve the tsx binary from our project's node_modules/.bin at runtime.
// This avoids any webpack/Next.js static analysis issues with tsx/esbuild.
function getTsxBin(): string {
  return path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
}

interface ChildResult { type: 'result'; data: unknown }
interface ChildError { type: 'error'; error: { message: string; stack?: string; code?: string } }
interface ChildReady { type: 'ready' }
type ChildMessage = ChildResult | ChildError | ChildReady

async function executeRuntimeSpec(spec: RuntimeToolSpec, args: Record<string, unknown>) {
  const src = spec.runtime.code?.trim()
  if (!src) return { error: 'Missing runtime.code for javascript tool.' }

  const safeName = sanitizeToolName(spec.name)
  const toolDir = getToolDir(safeName)
  const hash = simpleHash(src)
  const cachedHash = codeHashCache.get(safeName)

  // Rewrite exec file + harness when code changes
  if (hash !== cachedHash) {
    await ensureToolDeps(src, toolDir, spec.dependencies)
    await fs.mkdir(toolDir, { recursive: true })

    const execPath = path.join(toolDir, `exec.ts`)
    await fs.writeFile(execPath, rewriteImports(src, toolDir), 'utf8')

    const harnessPath = path.join(toolDir, `harness.ts`)
    await fs.writeFile(harnessPath, generateHarness(execPath), 'utf8')

    codeHashCache.set(safeName, hash)
  }

  const timeoutMs = Number(spec.runtime.config?.timeoutMs ?? 30000)
  const harnessPath = path.join(toolDir, `harness.ts`)

  return new Promise<Record<string, unknown>>((resolve) => {
    // Spawn tsx as the command with the harness as its argument.
    // stdio[3] = 'ipc' gives us a Node IPC channel for structured JSON messages,
    // while stdout/stderr remain available for the tool's own console output.
    const child = spawn(getTsxBin(), [harnessPath], {
      cwd: toolDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      timeout: timeoutMs,
    })

    let settled = false
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => finish({ error: `Tool execution timed out after ${timeoutMs}ms` }), timeoutMs)

    function finish(result: Record<string, unknown>) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('message', (msg: ChildMessage) => {
      if (msg.type === 'ready') {
        child.send({ type: 'invoke', args })
      } else if (msg.type === 'result') {
        finish({ ok: true, result: msg.data, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) })
      } else if (msg.type === 'error') {
        finish({ error: msg.error.message, stack: msg.error.stack, code: msg.error.code, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) })
      }
    })

    child.on('error', (err) => {
      finish({ error: `Child process error: ${err.message}`, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) })
    })

    child.on('exit', (code, signal) => {
      if (!settled) {
        finish({
          error: signal
            ? `Child process killed by signal ${signal}`
            : `Child process exited with code ${code}`,
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
        })
      }
    })
  })
}

async function ensureToolsDir() {
  await fs.mkdir(TOOLS_DIR, { recursive: true })
}

function getToolDir(name: string) {
  return path.join(TOOLS_DIR, sanitizeToolName(name))
}

async function saveToolSpec(spec: RuntimeToolSpec, overwrite = false) {
  await ensureToolsDir()
  const safeName = sanitizeToolName(spec.name)
  if (!safeName) throw new Error('Invalid tool name')

  // Strip null dependencies so spec.json stays clean in auto mode
  const { dependencies, ...rest } = spec
  const normalizedSpec: RuntimeToolSpec = {
    ...rest,
    name: safeName,
    ...(dependencies ? { dependencies } : {}),
  }
  const toolDir = getToolDir(safeName)
  const specPath = path.join(toolDir, SPEC_FILENAME)

  if (!overwrite) {
    try {
      await fs.access(specPath)
      throw new Error(`Tool already exists: ${safeName}`)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Tool already exists')) throw err
    }
  }

  await fs.mkdir(toolDir, { recursive: true })
  await fs.writeFile(specPath, JSON.stringify(normalizedSpec, null, 2) + '\n', 'utf8')

  // Eagerly generate execution files so the tool dir is self-contained immediately
  const src = normalizedSpec.runtime.code?.trim()
  if (src) {
    await ensureToolDeps(src, toolDir, normalizedSpec.dependencies)

    const execPath = path.join(toolDir, 'exec.ts')
    await fs.writeFile(execPath, rewriteImports(src, toolDir), 'utf8')

    const harnessPath = path.join(toolDir, 'harness.ts')
    await fs.writeFile(harnessPath, generateHarness(execPath), 'utf8')

    codeHashCache.set(safeName, simpleHash(src))
  }

  return specPath
}

async function loadRuntimeSpecs(): Promise<RuntimeToolSpec[]> {
  await ensureToolsDir()
  const entries = await fs.readdir(TOOLS_DIR, { withFileTypes: true })
  const specs: RuntimeToolSpec[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const specPath = path.join(TOOLS_DIR, entry.name, SPEC_FILENAME)
    try {
      const source = await fs.readFile(specPath, 'utf8')
      const spec = JSON.parse(source) as RuntimeToolSpec
      if (!spec?.name || !spec?.runtime?.kind || !spec?.parameters) continue
      specs.push(spec)
    } catch (err) {
      // Skip directories without a valid spec.json (or parse errors)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[tools] failed loading runtime tool', specPath, err)
      }
    }
  }

  return specs
}

function createRuntimeTool(spec: RuntimeToolSpec) {
  return tool({
    description: spec.description,
    parameters: buildParameterZodSchema(spec.parameters),
    execute: async (args) => {
      try {
        return await executeRuntimeSpec(spec, args as Record<string, unknown>)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

function parseParametersJson(text: string | null | undefined): Record<string, ParamField> | null {
  if (!text) return null
  const parsed = JSON.parse(text) as Record<string, ParamField>
  return parsed
}

function createBuiltinTools() {
  const runCommand = tool({
    description: 'Runs a shell command on the server and returns stdout/stderr.',
    parameters: z.object({
      command: z.string(),
      cwd: z.union([z.string(), z.null()]),
      timeoutMs: z.union([z.number(), z.null()]),
    }),
    execute: async ({ command, cwd, timeoutMs }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: cwd || process.cwd(),
          timeout: timeoutMs ?? 15000,
          shell: '/bin/bash',
          maxBuffer: 1024 * 1024,
        })
        return { ok: true, stdout, stderr }
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string }
        return { ok: false, error: e.message ?? String(err), stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
      }
    },
  })

  const fileWriteTool = tool({
    description: 'Writes content to a file path on the server.',
    parameters: z.object({
      filePath: z.string(),
      content: z.string(),
      append: z.union([z.boolean(), z.null()]),
    }),
    execute: async ({ filePath, content, append }) => {
      const abs = path.resolve(process.cwd(), filePath)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      if (append) await fs.appendFile(abs, content, 'utf8')
      else await fs.writeFile(abs, content, 'utf8')
      return { ok: true, filePath: abs, bytes: Buffer.byteLength(content, 'utf8'), append: Boolean(append) }
    },
  })

  const readFileTool = tool({
    description: 'Reads text content from a file path on the server.',
    parameters: z.object({
      filePath: z.string(),
      maxChars: z.union([z.number(), z.null()]),
    }),
    execute: async ({ filePath, maxChars }) => {
      const abs = path.resolve(process.cwd(), filePath)
      const content = await fs.readFile(abs, 'utf8')
      const max = maxChars ?? 12000
      return { ok: true, filePath: abs, content: content.slice(0, max), truncated: content.length > max }
    },
  })

  const toolBuilder = tool({
    description: 'Creates and persists a runtime tool with custom JavaScript/TypeScript code. Tools run in a full Node.js environment with access to fetch, Buffer, require(), import, and all Node built-ins. npm packages referenced via import/require are auto-installed into an isolated per-tool directory. You can optionally pin dependency versions via dependenciesJson.',
    parameters: z.object({
      name: z.string().describe('Tool name (e.g. my_tool)'),
      description: z.union([z.string(), z.null()]).describe('Optional custom description'),
      parametersJson: z.union([z.string(), z.null()]).describe('Optional JSON object schema for parameters'),
      code: z.union([z.string(), z.null()]).describe('Async function source like `async ({ args }) => ({ ok:true })`. Can use imports, require(), fetch, Buffer, and any Node.js API. npm packages are auto-installed.'),
      dependenciesJson: z.union([z.string(), z.null()]).describe('Optional JSON object of npm dependency version constraints, e.g. {"lodash":"^4.17.21","axios":"~1.6.0"}. When omitted (auto mode), deps are detected from code and installed at latest.'),
      overwrite: z.union([z.boolean(), z.null()]).describe('Overwrite existing tool if true'),
    }),
    execute: async ({ name, description, parametersJson, code, dependenciesJson, overwrite }) => {
      try {
        const safeName = sanitizeToolName(name)
        const existing = new Set(Object.keys(EXAMPLE_TOOLS))
        if (!safeName) return { error: 'Invalid tool name' }
        if (existing.has(safeName)) return { error: `Name collides with built-in tool: ${safeName}` }

        const template = getRuntimeTemplate()
        const parsedParameters = parseParametersJson(parametersJson)
        const parsedDeps = dependenciesJson ? JSON.parse(dependenciesJson) as Record<string, string> : null

        const spec: RuntimeToolSpec = {
          name: safeName,
          description: description?.trim() || template.description,
          icon: template.icon,
          parameters: parsedParameters ?? template.parameters,
          ...(parsedDeps ? { dependencies: parsedDeps } : {}),
          runtime: {
            kind: 'javascript',
            config: template.config,
            code: code?.trim() || template.code,
          },
        }

        const specPath = await saveToolSpec(spec, Boolean(overwrite))
        return { ok: true, toolName: safeName, specPath, toolDir: getToolDir(safeName), runtimeToolsDir: TOOLS_DIR }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const toolEditor = tool({
    description: 'Edits an existing runtime tool spec by name. In auto mode (no dependenciesJson), node_modules and package-lock.json are wiped so deps are freshly resolved on next run. Pass dependenciesJson to pin specific versions.',
    parameters: z.object({
      name: z.string(),
      description: z.union([z.string(), z.null()]),
      parametersJson: z.union([z.string(), z.null()]),
      code: z.union([z.string(), z.null()]),
      dependenciesJson: z.union([z.string(), z.null()]).describe('Optional JSON object of npm dependency version constraints, e.g. {"lodash":"^4.17.21"}. Pass null or omit to use auto-detection (wipes and reinstalls deps fresh). Pass "keep" to leave existing dependency config unchanged.'),
    }),
    execute: async ({ name, description, parametersJson, code, dependenciesJson }) => {
      try {
        const specs = await loadRuntimeSpecs()
        const safeName = sanitizeToolName(name)
        const current = specs.find((s) => sanitizeToolName(s.name) === safeName)
        if (!current) return { ok: false, error: `Tool not found: ${safeName}` }

        const template = getRuntimeTemplate()
        const parsedParameters = parseParametersJson(parametersJson)

        // Determine dependency strategy:
        // - "keep": preserve whatever the spec already has
        // - null/omitted: auto mode — clear pinned deps and wipe node_modules
        // - JSON string: manual mode — parse and set explicit deps
        let nextDeps: Record<string, string> | null | undefined
        let shouldResetDeps = false
        if (dependenciesJson === 'keep') {
          nextDeps = current.dependencies
        } else if (dependenciesJson) {
          nextDeps = JSON.parse(dependenciesJson) as Record<string, string>
          shouldResetDeps = true // new pinned deps — reinstall
        } else {
          nextDeps = null // auto mode
          shouldResetDeps = true // wipe so auto-detect runs fresh
        }

        const nextSpec: RuntimeToolSpec = {
          ...current,
          name: safeName,
          description: description ?? current.description,
          parameters: parsedParameters ?? current.parameters,
          dependencies: nextDeps,
          runtime: {
            kind: 'javascript',
            config: current.runtime.config ?? template.config,
            code: code ?? current.runtime.code ?? template.code,
          },
        }

        const toolDir = getToolDir(safeName)

        if (shouldResetDeps) {
          await resetToolDeps(toolDir)
        }

        const specPath = await saveToolSpec(nextSpec, true)
        return { ok: true, toolName: safeName, specPath, toolDir, depsReset: shouldResetDeps }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const toolDescribe = tool({
    description: 'Describes one runtime tool by name, or all runtime tools when name is empty.',
    parameters: z.object({
      name: z.union([z.string(), z.null()]),
      showAllProperties: z.union([z.boolean(), z.null()]).describe('Include the tool code and dependencies in the response'),
    }),
    execute: async ({ name, showAllProperties }) => {
      const specs = await loadRuntimeSpecs()
      if (!name) {
        return {
          ok: true,
          runtimeToolsDir: TOOLS_DIR,
          tools: specs.map((s) => ({ name: s.name, kind: s.runtime.kind, description: s.description, parameters: s.parameters, code: showAllProperties ? s.runtime.code : undefined, dependencies: showAllProperties ? s.dependencies : undefined })),
        }
      }
      const safeName = sanitizeToolName(name)
      const spec = specs.find((s) => sanitizeToolName(s.name) === safeName)
      if (!spec) return { ok: false, error: `Tool not found: ${safeName}` }
      return {
        ok: true,
        runtimeToolsDir: TOOLS_DIR,
        tool: spec,
        toolDir: getToolDir(safeName),
      }
    },
  })

  const reloadTools = tool({
    description: 'No-op reload helper. Runtime tools are loaded fresh each request.',
    parameters: z.object({
      reason: z.union([z.string(), z.null()]),
    }),
    execute: async ({ reason }) => {
      return { ok: true, reloaded: true, reason: reason ?? 'manual reload', runtimeToolsDir: TOOLS_DIR }
    },
  })

  return {
    run_command: runCommand,
    file_write: fileWriteTool,
    read_file: readFileTool,
    tool_builder: toolBuilder,
    tool_editor: toolEditor,
    tool_describe: toolDescribe,
    reload_tools: reloadTools,
  } as const
}

export async function getRuntimeTools() {
  const runtimeSpecs = await loadRuntimeSpecs()
  const runtimeTools: Record<string, unknown> = {}
  const runtimeMeta: Record<string, ToolMeta> = {}

  for (const spec of runtimeSpecs) {
    const name = sanitizeToolName(spec.name)
    if (!name) continue
    runtimeTools[name] = createRuntimeTool(spec)
    runtimeMeta[name] = {
      icon: spec.icon ?? '🧩',
      description: spec.description,
      expectedDurationMs: 1500,
      inputs: Object.entries(normalizeParameters(spec.parameters)).map(([k, v]) => `${k} (${v.type}${v.required ? '' : '?'})`),
      outputs: ['runtime result object', 'error (string?)'],
    }
  }

  return { runtimeTools, runtimeMeta }
}

export async function getAllChatTools() {
  const builtins = createBuiltinTools()
  const { runtimeTools } = await getRuntimeTools()
  return { ...EXAMPLE_TOOLS, ...builtins, ...runtimeTools }
}

export async function getAllToolMetadata(): Promise<Record<string, ToolMeta>> {
  const { runtimeMeta } = await getRuntimeTools()
  return {
    ...EXAMPLE_TOOL_METADATA,
    run_command: { icon: '🖥️', description: 'Run shell command and return stdout/stderr.', expectedDurationMs: 1200, inputs: ['command', 'cwd?', 'timeoutMs?'], outputs: ['ok', 'stdout', 'stderr', 'error?'] },
    file_write: { icon: '📝', description: 'Write file content on server.', expectedDurationMs: 150, inputs: ['filePath', 'content', 'append?'], outputs: ['ok', 'filePath', 'bytes'] },
    read_file: { icon: '📄', description: 'Read file content from server.', expectedDurationMs: 120, inputs: ['filePath', 'maxChars?'], outputs: ['ok', 'content', 'truncated'] },
    tool_builder: { icon: '🧰', description: 'Create runtime tools with custom JS code.', expectedDurationMs: 300, inputs: ['name', 'description?', 'parametersJson?', 'code?', 'overwrite?'], outputs: ['ok', 'toolName', 'filePath'] },
    tool_editor: { icon: '🛠️', description: 'Edit runtime tool specs.', expectedDurationMs: 250, inputs: ['name', 'description?', 'parametersJson?', 'code?'], outputs: ['ok', 'filePath'] },
    tool_describe: { icon: '🔎', description: 'Describe runtime tools.', expectedDurationMs: 120, inputs: ['name?'], outputs: ['tool | tools[]'] },
    reload_tools: { icon: '♻️', description: 'Compatibility helper (runtime tools load per request).', expectedDurationMs: 50, inputs: ['reason?'], outputs: ['ok', 'runtimeToolsDir'] },
    ...runtimeMeta,
  }
}

export function getRuntimeToolsDirectory() {
  return TOOLS_DIR
}
