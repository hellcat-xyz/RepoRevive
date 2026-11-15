import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { config } from './config';
import { prisma } from './db';
import { SESSION_COOKIE, sessionUserId } from './github/oauth';

export interface SessionUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/** Resolve the signed-in user from the HttpOnly session cookie. Null when absent, invalid, expired or the user was deleted. */
export async function currentUser(req: Pick<NextRequest, 'cookies'>): Promise<SessionUser | null> {
  const gh = config().github;
  if (!gh) return null;
  const id = sessionUserId(gh, req.cookies.get(SESSION_COOKIE)?.value);
  if (!id) return null;
  const u = await prisma.user.findUnique({
    where: { id },
    select: { id: true, login: true, avatarUrl: true },
  });
  return u ?? null;
}

/**
 * CSRF defence for cookie-authenticated mutations (in addition to SameSite=Lax): the Origin header,
 * when present, must match the configured app origin. Requests without Origin and without a session are harmless.
 */
export function sameOrigin(req: Pick<Request, 'headers'>): boolean {
  const gh = config().github;
  const origin = req.headers.get('origin');
  if (!gh) return false;
  if (!origin) return false;
  return origin === new URL(gh.baseUrl).origin;
}

export function forbiddenOrigin() {
  return NextResponse.json(
    { error: { code: 'BAD_ORIGIN', message: 'Cross-site request refused.' } },
    { status: 403 },
  );
}

/** Owned jobs are visible only to their owner; anonymous (historic) jobs stay readable by id. */
export function canView(job: { ownerId: string | null }, user: SessionUser | null): boolean {
  return job.ownerId === null || job.ownerId === user?.id;
}
export function canMutate(job: { ownerId: string | null }, user: SessionUser | null): boolean {
  return job.ownerId === null ? true : job.ownerId === user?.id;
}
