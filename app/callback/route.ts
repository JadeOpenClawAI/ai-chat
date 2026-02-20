import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const { search } = new URL(req.url)
  const host = req.headers.get('host') ?? 'localhost:1455'
  const protocol = host.includes('localhost') ? 'http' : 'https'
  return Response.redirect(`${protocol}://${host}/auth/anthropic/callback${search}`)
}
