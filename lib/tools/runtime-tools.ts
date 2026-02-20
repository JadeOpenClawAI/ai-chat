import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
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
    kind: 'http_request' | 'shell_command' | 'write_file' | 'echo'
    config?: Record<string, unknown>
  }
}

const TOOLS_DIR = process.env.AI_CHAT_TOOLS_DIR || path.join(os.homedir(), '.openclaw', 'ai-chat-tools')
const TOOL_FILE_SUFFIX = '.tool.js'

let forceReloadNonce = 0

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

    if (field.description) base = base.describe(field.description)
    if (!field.required) base = base.optional()
    shape[key] = base
  }
  return z.object(shape)
}

function getRuntimeTemplate(kind: RuntimeToolSpec['runtime']['kind']): {
  parameters: Record<string, ParamField>
  config: Record<string, unknown>
  description: string
  icon: string
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
    return {
      command,
      cwd,
      stdout,
      stderr,
      success: !stderr,
    }
  }

  if (kind === 'write_file') {
    const filePath = path.resolve(process.cwd(), String(args.filePath ?? ''))
    const content = String(args.content ?? '')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true, filePath, bytes: Buffer.byteLength(content, 'utf8') }
  }

  return { text: String(args.text ?? '') }
}

async function ensureToolsDir() {
  await fs.mkdir(TOOLS_DIR, { recursive: true })
}

async function createToolFile(spec: RuntimeToolSpec, overwrite = false) {
  await ensureToolsDir()
  const safeName = sanitizeToolName(spec.name)
  if (!safeName) throw new Error('Invalid tool name')

  const filePath = path.join(TOOLS_DIR, `${safeName}${TOOL_FILE_SUFFIX}`)
  if (!overwrite) {
    try {
      await fs.access(filePath)
      throw new Error(`Tool already exists: ${safeName}`)
    } catch {
      // file not present
    }
  }

  const content = `// Auto-generated by tool_builder\nexport default ${JSON.stringify(spec, null, 2)}\n`
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

function createBuiltinTools() {
  const runCommand = tool({
    description: 'Runs a shell command on the server and returns stdout/stderr.',
    parameters: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().optional(),
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
      append: z.boolean().optional(),
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
      maxChars: z.number().optional(),
    }),
    execute: async ({ filePath, maxChars }) => {
      const abs = path.resolve(process.cwd(), filePath)
      const content = await fs.readFile(abs, 'utf8')
      const max = maxChars ?? 12000
      return {
        ok: true,
        filePath: abs,
        content: content.slice(0, max),
        truncated: content.length > max,
      }
    },
  })

  const toolBuilder = tool({
    description: 'Creates and persists a new runtime tool (.tool.js) that will auto-load without server restart.',
    parameters: z.object({
      name: z.string().describe('Tool name (e.g. http_request)'),
      kind: z.enum(['http_request', 'shell_command', 'write_file', 'echo']).describe('Runtime template kind'),
      description: z.string().optional().describe('Optional custom description'),
      overwrite: z.boolean().optional().describe('Overwrite existing tool file if true'),
    }),
    execute: async ({ name, kind, description, overwrite }) => {
      const safeName = sanitizeToolName(name)
      const existing = new Set(Object.keys(EXAMPLE_TOOLS))
      if (!safeName) return { error: 'Invalid tool name' }
      if (existing.has(safeName)) {
        return { error: `Name collides with built-in tool: ${safeName}` }
      }

      const template = getRuntimeTemplate(kind)
      const spec: RuntimeToolSpec = {
        name: safeName,
        description: description?.trim() || template.description,
        icon: template.icon,
        parameters: template.parameters,
        runtime: {
          kind,
          config: template.config,
        },
      }
      const filePath = await createToolFile(spec, Boolean(overwrite))
      forceReloadNonce += 1
      return {
        ok: true,
        toolName: safeName,
        filePath,
        note: 'Tool saved and will be available in subsequent requests immediately.',
      }
    },
  })

  const reloadTools = tool({
    description: 'Forces runtime tool module cache-bust and reload on next request.',
    parameters: z.object({
      reason: z.string().optional(),
    }),
    execute: async ({ reason }) => {
      forceReloadNonce += 1
      return { ok: true, reloaded: true, reason: reason ?? 'manual reload' }
    },
  })

  return {
    run_command: runCommand,
    write_file: writeFileTool,
    read_file: readFileTool,
    tool_builder: toolBuilder,
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

  return {
    ...EXAMPLE_TOOLS,
    ...builtins,
    ...runtimeTools,
  }
}

export async function getAllToolMetadata(): Promise<Record<string, ToolMeta>> {
  const { runtimeMeta } = await getRuntimeTools()
  return {
    ...EXAMPLE_TOOL_METADATA,
    run_command: {
      icon: '🖥️',
      description: 'Run shell command and return stdout/stderr.',
      expectedDurationMs: 1200,
      inputs: ['command', 'cwd?', 'timeoutMs?'],
      outputs: ['ok', 'stdout', 'stderr', 'error?'],
    },
    write_file: {
      icon: '📝',
      description: 'Write file content on server.',
      expectedDurationMs: 150,
      inputs: ['filePath', 'content', 'append?'],
      outputs: ['ok', 'filePath', 'bytes'],
    },
    read_file: {
      icon: '📄',
      description: 'Read file content from server.',
      expectedDurationMs: 120,
      inputs: ['filePath', 'maxChars?'],
      outputs: ['ok', 'content', 'truncated'],
    },
    tool_builder: {
      icon: '🧰',
      description: 'Creates runtime tools and persists them to disk.',
      expectedDurationMs: 300,
      inputs: ['name', 'kind', 'description?', 'overwrite?'],
      outputs: ['toolName', 'filePath', 'ok'],
    },
    reload_tools: {
      icon: '♻️',
      description: 'Force cache-bust reload for runtime tools.',
      expectedDurationMs: 50,
      inputs: ['reason?'],
      outputs: ['ok', 'reloaded'],
    },
    ...runtimeMeta,
  }
}

export function getRuntimeToolsDirectory() {
  return TOOLS_DIR
}
