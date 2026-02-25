import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const SESSION_COOKIE = 'ai-chat-session'
const AUTH_SECRET = process.env.AUTH_SECRET ?? ''

// Paths that are always public
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  // OAuth callbacks — must remain accessible for redirect flows
  '/auth/callback',
  '/auth/anthropic/callback',
  '/auth/google/callback',
  '/callback',
  '/api/auth/codex',
  '/api/auth/codex/authorize',
  '/api/auth/codex/callback',
  '/api/auth/anthropic/authorize',
  '/api/auth/anthropic/callback',
  '/api/auth/google/authorize',
  // OpenAI/Anthropic compat endpoints — auth handled by per-endpoint API key
  '/api/v1',
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow public paths and Next.js internals
  if (isPublic(pathname) || pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next()
  }

  // If AUTH_PASSWORD is not set, skip auth entirely (dev convenience)
  if (!process.env.AUTH_PASSWORD) {
    return NextResponse.next()
  }

  const session = request.cookies.get(SESSION_COOKIE)

  if (session?.value === AUTH_SECRET) {
    return NextResponse.next()
  }

  // API requests get 401, page requests get redirect to /login
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = '/login'
  loginUrl.searchParams.set('from', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
