// ============================================================
// Tool definitions exposed to Vercel AI SDK
// Wraps example tools with summarization support
// ============================================================

import { ALL_TOOLS } from '@/lib/tools/examples'

// Re-export all tools for use in the API route
export const chatTools = ALL_TOOLS
