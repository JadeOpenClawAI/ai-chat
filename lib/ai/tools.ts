// ============================================================
// Tool definitions exposed to Vercel AI SDK
// Includes static example tools + built-in runtime tools + persisted tools
// ============================================================

import { getAllChatTools, getAllToolMetadata } from '@/lib/tools/runtime-tools'

export async function getChatTools() {
  return getAllChatTools()
}

export async function getToolMetadata() {
  return getAllToolMetadata()
}
