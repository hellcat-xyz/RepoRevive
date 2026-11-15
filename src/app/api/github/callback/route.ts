import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { config } from '@/server/config';
import { prisma } from '@/server/db';
import { verifyValue } from '@/server/github/crypto';
import { completeLogin } from '@/server/github/connection';
import {
  checkState,
  OAuthError,
  RETURN_COOKIE,
  safeReturnTo,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionCookieValue,
  STATE_COOKIE,
} from '@/server/github/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function done(gh: NonNullable<ReturnType<typeof config>['github']>, to: string, query: string) {
  const url = new URL(to, gh.baseUrl);
  if (query) url.searchParams.set('github', query);
  const res = NextResponse.redirect(url, 302);
  res.cookies.delete({ name: STATE_COOKIE, path: '/api/github' }); // single use
  res.cookies.delete({ name: RETURN_COOKIE, path: '/api/github' });
  return res;
}

export async function GET(req: NextRequest) {
  const gh = config().github;
  if (!gh)
    return jsonError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub integration is not configured on this server.');
  const params = req.nextUrl.searchParams;
  const encoded = verifyValue(gh.sessionSecret, 'return-to', req.cookies.get(RETURN_COOKIE)?.value);
  const returnTo = safeReturnTo(encoded ? Buffer.from(encoded, 'base64url').toString() : '/');

  // CSRF: the state must match the signed cookie created by /connect in this browser.
  if (!checkState(gh, req.cookies.get(STATE_COOKIE)?.value, params.get('state')))
    return done(gh, returnTo, 'state-mismatch');
  if (params.get('error')) return done(gh, returnTo, 'denied');
  const code = params.get('code');
  if (!code || code.length > 200) return done(gh, returnTo, 'error');

  try {
    const user = await completeLogin(prisma, gh, code);
    const res = done(gh, returnTo, 'connected');
    res.cookies.set(SESSION_COOKIE, sessionCookieValue(gh, user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: gh.baseUrl.startsWith('https://'),
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
    return res;
  } catch (err) {
    console.error('[github] callback failed', err instanceof OAuthError ? err.code : 'unknown');
    return done(gh, returnTo, 'error');
  }
}
