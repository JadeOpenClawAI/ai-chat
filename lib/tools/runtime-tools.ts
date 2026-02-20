import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import vm from 'node:vm'
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

type RuntimeKind = 'http_request' | 'shell_command' | 'write_file' | 'echo' | 'javascript'

interface ParamField {
  type: PrimitiveType
  description?: string
  required?: boolean
  enum?: string[]
}

interface RuntimeToolSpec {
  name: string
  description: string
  icon?: string
  parameters: Record<string, ParamField>
  runtime: {
    kind: RuntimeKind
    code?: string
    config?: Record<string, unknown>
  }
}

const TOOLS_DIR = process.env.AI_CHAT_TOOLS_DIR || path.join(process.cwd(), 'runtime-tools')
const TOOL_FILE_SUFFIX = '.tool.js'

function sanitizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
}

function buildParameterZodSchema(schema: Record<string, ParamField>) {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, field] of Object.entries(schema)) {
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

function getRuntimeTemplate(kind: RuntimeKind): {
  parameters: Record<string, ParamField>
  config: Record<string, unknown>
  description: string
  icon: string
  code?: string
} {
  if (kind === 'http_request') {
    return {
      parameters: {
        url: { type: 'string', description: 'Request URL', required: true },
        method: { type: 'string', description: 'HTTP method', required: false, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headersJson: { type: 'string', description: 'JSON object of headers', required: false },
        body: { type: 'string', description: 'Request body text/json', required: false },
      },
      config: { maxResponseChars: 8000 },
      description: 'Performs an HTTP request and returns status, headers, and response body preview.',
      icon: '🌐',
    }
  }

  if (kind === 'shell_command') {
    return {
      parameters: {
        command: { type: 'string', description: 'Shell command to run', required: true },
        cwd: { type: 'string', description: 'Working directory', required: false },
      },
      config: { timeoutMs: 15000 },
      description: 'Runs a shell command and returns stdout/stderr.',
      icon: '🖥️',
    }
  }

  if (kind === 'write_file') {
    return {
      parameters: {
        filePath: { type: 'string', description: 'Path to file', required: true },
        content: { type: 'string', description: 'File content', required: true },
      },
      config: {},
      description: 'Writes content to a file path.',
      icon: '📝',
    }
  }

  if (kind === 'javascript') {
    return {
      parameters: {
        input: { type: 'string', description: 'Input string passed to your JS handler', required: false },
      },
      config: { timeoutMs: 5000 },
      description: 'Runs custom JavaScript handler code from this tool spec.',
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

  return {
    parameters: {
      text: { type: 'string', description: 'Text to echo', required: true },
    },
    config: {},
    description: 'Echoes text.',
    icon: '🪞',
  }
}

async function executeRuntimeSpec(spec: RuntimeToolSpec, args: Record<string, unknown>) {
  const kind = spec.runtime.kind

  if (kind === 'http_request') {
    const url = String(args.url ?? '')
    const method = String(args.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    if (args.headersJson) {
      try {
        const parsed = JSON.parse(String(args.headersJson)) as Record<string, unknown>
        for (const [k, v] of Object.entries(parsed)) headers[k] = String(v)
      } catch {
        return { error: 'Invalid headersJson. Must be valid JSON object.' }
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: args.body ? String(args.body) : undefined,
    })

    const maxChars = Number(spec.runtime.config?.maxResponseChars ?? 8000)
    const text = (await res.text()).slice(0, maxChars)
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      bodyPreview: text,
      truncated: text.length >= maxChars,
    }
  }

  if (kind === 'shell_command') {
    const command = String(args.command ?? '')
    const cwd = args.cwd ? String(args.cwd) : process.cwd()
    const timeout = Number(spec.runtime.config?.timeoutMs ?? 15000)
    const { stdout, stderr } = await execAsync(command, { cwd, timeout, shell: '/bin/bash', maxBuffer: 1024 * 1024 })
    return { command, cwd, stdout, stderr, success: !stderr }
  }

  if (kind === 'write_file') {
    const filePath = path.resolve(process.cwd(), String(args.filePath ?? ''))
    const content = String(args.content ?? '')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true, filePath, bytes: Buffer.byteLength(content, 'utf8') }
  }

  if (kind === 'javascript') {
    const src = spec.runtime.code?.trim()
    if (!src) return { error: 'Missing runtime.code for javascript tool.' }
    const timeoutMs = Number(spec.runtime.config?.timeoutMs ?? 5000)
    const runner = vm.runInNewContext(`(${src})`, { console, JSON, Math, Date }, { timeout: timeoutMs }) as (ctx: { args: Record<string, unknown> }) => unknown
    const result = await Promise.resolve(runner({ args }))
    return { ok: true, result }
  }

  return { text: String(args.text ?? '') }
}

async function ensureToolsDir() {
  await fs.mkdir(TOOLS_DIR, { recursive: true })
}

function getToolFilePath(name: string) {
  const safeName = sanitizeToolName(name)
  return path.join(TOOLS_DIR, `${safeName}${TOOL_FILE_SUFFIX}`)
}

async function saveToolSpec(spec: RuntimeToolSpec, overwrite = false) {
  await ensureToolsDir()
  const safeName = sanitizeToolName(spec.name)
  if (!safeName) throw new Error('Invalid tool name')

  const normalizedSpec: RuntimeToolSpec = { ...spec, name: safeName }
  const filePath = getToolFilePath(safeName)

  if (!overwrite) {
    try {
      await fs.access(filePath)
      throw new Error(`Tool already exists: ${safeName}`)
    } catch {
      // file not present
    }
  }

  const content = `// Auto-generated by tool_builder/tool_editor\nexport default ${JSON.stringify(normalizedSpec, null, 2)}\n`
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

async function loadRuntimeSpecs(): Promise<RuntimeToolSpec[]> {
  await ensureToolsDir()
  const entries = await fs.readdir(TOOLS_DIR, { withFileTypes: true })
  const specs: RuntimeToolSpec[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(TOOL_FILE_SUFFIX)) continue
    const fullPath = path.join(TOOLS_DIR, entry.name)
    try {
      const source = await fs.readFile(fullPath, 'utf8')
      const match = source.match(/export\s+default\s+([\s\S]+)$/)
      if (!match?.[1]) throw new Error('Missing `export default` object')
      const objectLiteral = match[1].trim().replace(/;\s*$/, '')
      const spec = vm.runInNewContext(`(${objectLiteral})`) as RuntimeToolSpec
      if (!spec?.name || !spec?.runtime?.kind || !spec?.parameters) continue
      specs.push(spec)
    } catch (err) {
      console.error('[tools] failed loading runtime tool', fullPath, err)
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

  const writeFileTool = tool({
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
    description: 'Creates and persists a runtime tool (.tool.js). Supports templates and custom javascript code.',
    parameters: z.object({
      name: z.string().describe('Tool name (e.g. http_request)'),
      kind: z.enum(['http_request', 'shell_command', 'write_file', 'echo', 'javascript']).describe('Runtime kind'),
      description: z.union([z.string(), z.null()]).describe('Optional custom description'),
      parametersJson: z.union([z.string(), z.null()]).describe('Optional JSON object schema for parameters'),
      code: z.union([z.string(), z.null()]).describe('For kind=javascript: async function source like `async ({ args }) => ({ ok:true })`'),
      overwrite: z.union([z.boolean(), z.null()]).describe('Overwrite existing tool if true'),
    }),
    execute: async ({ name, kind, description, parametersJson, code, overwrite }) => {
      try {
        const safeName = sanitizeToolName(name)
        const existing = new Set(Object.keys(EXAMPLE_TOOLS))
        if (!safeName) return { error: 'Invalid tool name' }
        if (existing.has(safeName)) return { error: `Name collides with built-in tool: ${safeName}` }

        const template = getRuntimeTemplate(kind)
        const parsedParameters = parseParametersJson(parametersJson)

        const spec: RuntimeToolSpec = {
          name: safeName,
          description: description?.trim() || template.description,
          icon: template.icon,
          parameters: parsedParameters ?? template.parameters,
          runtime: {
            kind,
            config: template.config,
            ...(kind === 'javascript' ? { code: code?.trim() || template.code } : {}),
          },
        }

        const filePath = await saveToolSpec(spec, Boolean(overwrite))
        return { ok: true, toolName: safeName, filePath, runtimeToolsDir: TOOLS_DIR }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const toolEditor = tool({
    description: 'Edits an existing runtime tool spec by name (description, parametersJson, code, kind).',
    parameters: z.object({
      name: z.string(),
      kind: z.union([z.enum(['http_request', 'shell_command', 'write_file', 'echo', 'javascript']), z.null()]),
      description: z.union([z.string(), z.null()]),
      parametersJson: z.union([z.string(), z.null()]),
      code: z.union([z.string(), z.null()]),
    }),
    execute: async ({ name, kind, description, parametersJson, code }) => {
      try {
        const specs = await loadRuntimeSpecs()
        const safeName = sanitizeToolName(name)
        const current = specs.find((s) => sanitizeToolName(s.name) === safeName)
        if (!current) return { ok: false, error: `Tool not found: ${safeName}` }

        const nextKind = kind ?? current.runtime.kind
        const template = getRuntimeTemplate(nextKind)
        const parsedParameters = parseParametersJson(parametersJson)

        const nextSpec: RuntimeToolSpec = {
          ...current,
          name: safeName,
          description: description ?? current.description,
          parameters: parsedParameters ?? current.parameters,
          runtime: {
            ...current.runtime,
            kind: nextKind,
            config: current.runtime.config ?? template.config,
            ...(nextKind === 'javascript'
              ? { code: code ?? current.runtime.code ?? template.code }
              : { code: undefined }),
          },
        }

        const filePath = await saveToolSpec(nextSpec, true)
        return { ok: true, toolName: safeName, filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  const toolDescribe = tool({
    description: 'Describes one runtime tool by name, or all runtime tools when name is empty.',
    parameters: z.object({
      name: z.union([z.string(), z.null()]),
    }),
    execute: async ({ name }) => {
      const specs = await loadRuntimeSpecs()
      if (!name) {
        return {
          ok: true,
          runtimeToolsDir: TOOLS_DIR,
          tools: specs.map((s) => ({ name: s.name, kind: s.runtime.kind, description: s.description, parameters: s.parameters })),
        }
      }
      const safeName = sanitizeToolName(name)
      const spec = specs.find((s) => sanitizeToolName(s.name) === safeName)
      if (!spec) return { ok: false, error: `Tool not found: ${safeName}` }
      return {
        ok: true,
        runtimeToolsDir: TOOLS_DIR,
        tool: spec,
        filePath: getToolFilePath(safeName),
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
    write_file: writeFileTool,
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
      inputs: Object.entries(spec.parameters).map(([k, v]) => `${k} (${v.type}${v.required ? '' : '?'})`),
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
    write_file: { icon: '📝', description: 'Write file content on server.', expectedDurationMs: 150, inputs: ['filePath', 'content', 'append?'], outputs: ['ok', 'filePath', 'bytes'] },
    read_file: { icon: '📄', description: 'Read file content from server.', expectedDurationMs: 120, inputs: ['filePath', 'maxChars?'], outputs: ['ok', 'content', 'truncated'] },
    tool_builder: { icon: '🧰', description: 'Create runtime tools (templates or custom JS code).', expectedDurationMs: 300, inputs: ['name', 'kind', 'description?', 'parametersJson?', 'code?', 'overwrite?'], outputs: ['ok', 'toolName', 'filePath'] },
    tool_editor: { icon: '🛠️', description: 'Edit runtime tool specs.', expectedDurationMs: 250, inputs: ['name', 'kind?', 'description?', 'parametersJson?', 'code?'], outputs: ['ok', 'filePath'] },
    tool_describe: { icon: '🔎', description: 'Describe runtime tools.', expectedDurationMs: 120, inputs: ['name?'], outputs: ['tool | tools[]'] },
    reload_tools: { icon: '♻️', description: 'Compatibility helper (runtime tools load per request).', expectedDurationMs: 50, inputs: ['reason?'], outputs: ['ok', 'runtimeToolsDir'] },
    ...runtimeMeta,
  }
}

export function getRuntimeToolsDirectory() {
  return TOOLS_DIR
}
