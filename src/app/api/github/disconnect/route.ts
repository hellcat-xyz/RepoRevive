import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { currentUser, forbiddenOrigin, sameOrigin } from '@/server/auth';
import { config } from '@/server/config';
import { prisma } from '@/server/db';
import { disconnect } from '@/server/github/connection';
import { SESSION_COOKIE } from '@/server/github/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revoke the app's grant at GitHub, delete stored credentials, and end the session. */
export async function POST(req: NextRequest) {
  const gh = config().github;
  if (!gh)
    return jsonError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub integration is not configured on this server.');
  if (!sameOrigin(req)) return forbiddenOrigin();
  const user = await currentUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Not signed in.');
  const { revoked } = await disconnect(prisma, gh, user.id);
  // Publications that were waiting for this user can no longer run.
  await prisma.publication.updateMany({
    where: { resurrection: { ownerId: user.id }, status: { in: ['PENDING_APPROVAL', 'QUEUED'] } },
    data: { status: 'AUTH_EXPIRED', lastError: 'GitHub was disconnected.', lastErrorCode: 'AUTH_EXPIRED' },
  });
  const res = NextResponse.json({ ok: true, revokedAtGithub: revoked });
  res.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  return res;
}
