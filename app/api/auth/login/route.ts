import { NextResponse } from 'next/server';

const SESSION_COOKIE = 'ai-chat-session';
// Max-age for "remember me": 30 days; otherwise session cookie (no maxAge)
const REMEMBER_MAX_AGE = 60 * 60 * 24 * 30;

export async function POST(request: Request) {
  const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
  const AUTH_SECRET = process.env.AUTH_SECRET ?? '';

  if (!AUTH_PASSWORD) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
  }

  let body: { password?: string; remember?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  if (body.password !== AUTH_PASSWORD) {
    // Constant-time-ish delay to slow brute force
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });

  const cookieOptions: Parameters<typeof response.cookies.set>[2] = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  };

  if (body.remember) {
    cookieOptions.maxAge = REMEMBER_MAX_AGE;
  }

  response.cookies.set(SESSION_COOKIE, AUTH_SECRET, cookieOptions);
  return response;
}
