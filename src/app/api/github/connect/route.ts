import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { config } from '@/server/config';
import {
  authorizeUrl,
  newState,
  RETURN_COOKIE,
  safeReturnTo,
  STATE_COOKIE,
  STATE_MAX_AGE,
} from '@/server/github/oauth';
import { signValue } from '@/server/github/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start the GitHub App user authorization. Binds a random single-use `state` to this browser. */
export async function GET(req: NextRequest) {
  const gh = config().github;
  if (!gh)
    return jsonError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub integration is not configured on this server.');
  const { state, cookie } = newState(gh);
  const res = NextResponse.redirect(authorizeUrl(gh, state), 302);
  const secure = gh.baseUrl.startsWith('https://');
  const opts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/api/github',
    maxAge: STATE_MAX_AGE,
  };
  res.cookies.set(STATE_COOKIE, cookie, opts);
  res.cookies.set(
    RETURN_COOKIE,
    signValue(
      gh.sessionSecret,
      'return-to',
      Buffer.from(safeReturnTo(req.nextUrl.searchParams.get('returnTo'))).toString('base64url'),
      STATE_MAX_AGE,
    ),
    opts,
  );
  return res;
}
