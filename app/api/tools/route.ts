// ============================================================
// Tool Execution Tracking API
// GET /api/tools — returns tool definitions + metadata
// ============================================================

import { TOOL_METADATA, ALL_TOOLS } from '@/lib/tools/examples'

export async function GET() {
  const tools = Object.entries(ALL_TOOLS).map(([name, tool]) => {
    const meta = TOOL_METADATA[name as keyof typeof TOOL_METADATA]
    return {
      name,
      description: tool.description,
      icon: meta?.icon ?? '🔧',
      expectedDurationMs: meta?.expectedDurationMs ?? 1000,
      inputs: meta?.inputs ?? [],
      outputs: meta?.outputs ?? [],
    }
  })

  return Response.json({ tools })
}
