/* eslint-disable max-len */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';

interface ParamField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
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
  dependencies?: Record<string, string> | null;
  runtime: {
    kind: 'javascript';
    code?: string;
    config?: Record<string, unknown>;
  };
}

interface RuntimeTemplate {
  parameters: Record<string, ParamField>;
  config: Record<string, unknown>;
  description: string;
  icon: string;
  code: string;
}

interface RuntimeManagementDeps {
  sanitizeToolName: (name: string) => string;
  parseParametersJson: (text: string | null | undefined) => ToolParameters | null;
  getRuntimeTemplate: () => RuntimeTemplate;
  saveToolSpec: (spec: RuntimeToolSpec, overwrite?: boolean) => Promise<string>;
  loadRuntimeSpecs: () => Promise<RuntimeToolSpec[]>;
  resetToolDeps: (toolDir: string) => Promise<void>;
  getToolDir: (name: string) => string;
  runtimeToolsDir: string;
  getReservedToolNames: () => Set<string>;
}

type RuntimeManagementToolName = 'tool_builder' | 'tool_editor' | 'tool_describe' | 'reload_tools';

interface RuntimeManagementToolMeta {
  icon: string;
  description: string;
  expectedDurationMs: number;
  inputs: string[];
  outputs: string[];
}

export const RUNTIME_MANAGEMENT_TOOL_METADATA: Record<RuntimeManagementToolName, RuntimeManagementToolMeta> = {
  tool_builder: {
    icon: '🧰',
    description: 'Create runtime tools with custom JS code.',
    expectedDurationMs: 300,
    inputs: ['name', 'description?', 'parametersJson?', 'code?', 'overwrite?'],
    outputs: ['ok', 'toolName', 'filePath'],
  },
  tool_editor: {
    icon: '🛠️',
    description: 'Edit runtime tool specs.',
    expectedDurationMs: 250,
    inputs: ['name', 'description?', 'parametersJson?', 'code?'],
    outputs: ['ok', 'filePath'],
  },
  tool_describe: {
    icon: '🔎',
    description: 'Describe runtime tools.',
    expectedDurationMs: 120,
    inputs: ['name?'],
    outputs: ['tool | tools[]'],
  },
  reload_tools: {
    icon: '♻️',
    description: 'Compatibility helper (runtime tools load per request).',
    expectedDurationMs: 50,
    inputs: ['reason?'],
    outputs: ['ok', 'runtimeToolsDir'],
  },
};

export function createRuntimeManagementTools(deps: RuntimeManagementDeps) {
  const toolBuilder = createTool({
    id: 'tool_builder',
    description: 'Creates and persists a runtime tool with custom JavaScript/TypeScript code. Tools run in a full Node.js environment with access to fetch, Buffer, require(), import, and all Node built-ins. npm packages referenced via import/require are auto-installed into an isolated per-tool directory. You can optionally pin dependency versions via dependenciesJson.',
    inputSchema: z.object({
      name: z.string().describe('Tool name (e.g. my_tool)'),
      description: z.union([z.string(), z.null()]).describe('Optional custom description'),
      parametersJson: z.union([z.string(), z.null()]).describe('Optional JSON object schema for parameters'),
      code: z.union([z.string(), z.null()]).describe('Async function source like `async ({ args }) => ({ ok:true })`. Can use imports, require(), fetch, Buffer, and any Node.js API. npm packages are auto-installed.'),
      dependenciesJson: z.union([z.string(), z.null()]).describe('Optional JSON object of npm dependency version constraints, e.g. {"lodash":"^4.17.21","axios":"~1.6.0"}. When omitted (auto mode), deps are detected from code and installed at latest.'),
      overwrite: z.union([z.boolean(), z.null()]).describe('Overwrite existing tool if true'),
    }),
    execute: async ({ name, description, parametersJson, code, dependenciesJson, overwrite }) => {
      try {
        const safeName = deps.sanitizeToolName(name);
        const existing = deps.getReservedToolNames();
        if (!safeName) {
          return { error: 'Invalid tool name' };
        }
        if (existing.has(safeName)) {
          return { error: `Name collides with built-in tool: ${safeName}` };
        }

        const template = deps.getRuntimeTemplate();
        const parsedParameters = deps.parseParametersJson(parametersJson);
        const parsedDeps = dependenciesJson ? JSON.parse(dependenciesJson) as Record<string, string> : null;

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
        };

        const specPath = await deps.saveToolSpec(spec, Boolean(overwrite));
        return { ok: true, toolName: safeName, specPath, toolDir: deps.getToolDir(safeName), runtimeToolsDir: deps.runtimeToolsDir };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const toolEditor = createTool({
    id: 'tool_editor',
    description: 'Edits an existing runtime tool spec by name. In auto mode (no dependenciesJson), node_modules and package-lock.json are wiped so deps are freshly resolved on next run. Pass dependenciesJson to pin specific versions.',
    inputSchema: z.object({
      name: z.string(),
      description: z.union([z.string(), z.null()]),
      parametersJson: z.union([z.string(), z.null()]),
      code: z.union([z.string(), z.null()]),
      dependenciesJson: z.union([z.string(), z.null()]).describe('Optional JSON object of npm dependency version constraints, e.g. {"lodash":"^4.17.21"}. Pass null or omit to use auto-detection (wipes and reinstalls deps fresh). Pass "keep" to leave existing dependency config unchanged.'),
    }),
    execute: async ({ name, description, parametersJson, code, dependenciesJson }) => {
      try {
        const specs = await deps.loadRuntimeSpecs();
        const safeName = deps.sanitizeToolName(name);
        const current = specs.find((spec) => deps.sanitizeToolName(spec.name) === safeName);
        if (!current) {
          return { ok: false, error: `Tool not found: ${safeName}` };
        }

        const template = deps.getRuntimeTemplate();
        const parsedParameters = deps.parseParametersJson(parametersJson);

        let nextDeps: Record<string, string> | null | undefined;
        let shouldResetDeps = false;
        if (dependenciesJson === 'keep') {
          nextDeps = current.dependencies;
        } else if (dependenciesJson) {
          nextDeps = JSON.parse(dependenciesJson) as Record<string, string>;
          shouldResetDeps = true;
        } else {
          nextDeps = null;
          shouldResetDeps = true;
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
        };

        const toolDir = deps.getToolDir(safeName);
        if (shouldResetDeps) {
          await deps.resetToolDeps(toolDir);
        }

        const specPath = await deps.saveToolSpec(nextSpec, true);
        return { ok: true, toolName: safeName, specPath, toolDir, depsReset: shouldResetDeps };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const toolDescribe = createTool({
    id: 'tool_describe',
    description: 'Describes one runtime tool by name, or all runtime tools when name is empty.',
    inputSchema: z.object({
      name: z.union([z.string(), z.null()]),
      showAllProperties: z.union([z.boolean(), z.null()]).describe('Include the tool code and dependencies in the response'),
    }),
    execute: async ({ name, showAllProperties }) => {
      const specs = await deps.loadRuntimeSpecs();
      if (!name) {
        return {
          ok: true,
          runtimeToolsDir: deps.runtimeToolsDir,
          tools: specs.map((spec) => ({
            name: spec.name,
            kind: spec.runtime.kind,
            description: spec.description,
            inputSchema: spec.parameters,
            code: showAllProperties ? spec.runtime.code : undefined,
            dependencies: showAllProperties ? spec.dependencies : undefined,
          })),
        };
      }

      const safeName = deps.sanitizeToolName(name);
      const spec = specs.find((candidate) => deps.sanitizeToolName(candidate.name) === safeName);
      if (!spec) {
        return { ok: false, error: `Tool not found: ${safeName}` };
      }
      return {
        ok: true,
        runtimeToolsDir: deps.runtimeToolsDir,
        tool: spec,
        toolDir: deps.getToolDir(safeName),
      };
    },
  });

  const reloadTools = createTool({
    id: 'reload_tools',
    description: 'No-op reload helper. Runtime tools are loaded fresh each request.',
    inputSchema: z.object({
      reason: z.union([z.string(), z.null()]),
    }),
    execute: async ({ reason }) => {
      return { ok: true, reloaded: true, reason: reason ?? 'manual reload', runtimeToolsDir: deps.runtimeToolsDir };
    },
  });

  return {
    tool_builder: toolBuilder,
    tool_editor: toolEditor,
    tool_describe: toolDescribe,
    reload_tools: reloadTools,
  } as const;
}
