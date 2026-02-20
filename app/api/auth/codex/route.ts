import { refreshCodexToken } from '@/lib/ai/codex-auth'

export async function POST(_req: Request) {
  try {
    const token = await refreshCodexToken()
    return Response.json({
      success: true,
    })
  } catch (err) {
    return Response.json(
      { success: false, error: String(err) },
      { status: 500 },
    )
  }
}
