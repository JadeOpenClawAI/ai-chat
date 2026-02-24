import { NextResponse } from 'next/server';

const SESSION_COOKIE = 'ai-chat-session';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { maxAge: 0, path: '/' });
  return response;
}
