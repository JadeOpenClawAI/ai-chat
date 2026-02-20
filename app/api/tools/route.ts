// ============================================================
// Tool Execution Tracking API
// GET /api/tools — returns tool definitions + metadata
// ============================================================

import { getChatTools, getToolMetadata } from '@/lib/ai/tools'
import { getRuntimeToolsDirectory } from '@/lib/tools/runtime-tools'

export async function GET() {
  const allTools = await getChatTools()
  const metadata = await getToolMetadata()

  const tools = Object.entries(allTools).map(([name, tool]) => {
    const meta = metadata[name]
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
