import { calculatorTool, calculatorToolMetadata } from '@/lib/tools/builtins/calculator';
import { webSearchTool, webSearchToolMetadata } from '@/lib/tools/builtins/web-search';
import { codeRunnerTool, codeRunnerToolMetadata } from '@/lib/tools/builtins/code-runner';
import { fileReaderTool, fileReaderToolMetadata } from '@/lib/tools/builtins/file-reader';
import { fileWriterTool, fileWriterToolMetadata } from '@/lib/tools/builtins/file-writer';
import { currentTimeTool, currentTimeToolMetadata } from '@/lib/tools/builtins/current-time';
import { settingsConfigTool, settingsConfigToolMetadata } from '@/lib/tools/builtins/settings-config';
import { runCliTool, runCliToolMetadata } from '@/lib/tools/builtins/run-cli';
import { httpRequestTool, httpRequestToolMetadata } from '@/lib/tools/builtins/http-request';
import type { BuiltinToolMetadata } from '@/lib/tools/builtins/types';

export const ALL_BUILTIN_TOOLS = {
  calculator: calculatorTool,
  web_search: webSearchTool,
  code_runner: codeRunnerTool,
  file_reader: fileReaderTool,
  file_writer: fileWriterTool,
  current_time: currentTimeTool,
  settings_config: settingsConfigTool,
  run_cli: runCliTool,
  http_request: httpRequestTool,
} as const;

export type BuiltinToolName = keyof typeof ALL_BUILTIN_TOOLS;

export const BUILTIN_TOOL_METADATA: Record<BuiltinToolName, BuiltinToolMetadata> = {
  calculator: calculatorToolMetadata,
  web_search: webSearchToolMetadata,
  code_runner: codeRunnerToolMetadata,
  file_reader: fileReaderToolMetadata,
  file_writer: fileWriterToolMetadata,
  current_time: currentTimeToolMetadata,
  settings_config: settingsConfigToolMetadata,
  run_cli: runCliToolMetadata,
  http_request: httpRequestToolMetadata,
};
