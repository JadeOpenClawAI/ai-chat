export interface BuiltinToolMetadata {
  icon: string;
  description: string;
  expectedDurationMs: number;
  inputs: string[];
  outputs: string[];
  inputSchema?: unknown;
}
