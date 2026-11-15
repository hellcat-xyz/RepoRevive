import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, validJobId } from '@/server/api';
import { currentUser, forbiddenOrigin, sameOrigin } from '@/server/auth';
import { prisma } from '@/server/db';
import { applyPublicationAction, toPublicationDto } from '@/server/publications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Publication state. Visible only to the job's owner (publication data names the user's GitHub repositories). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const job = await prisma.resurrection.findUnique({
    where: { id },
    select: { ownerId: true, publishMode: true, publication: true },
  });
  const user = await currentUser(req);
  if (!job || !job.ownerId || job.ownerId !== user?.id)
    return jsonError(404, 'NOT_FOUND', 'No such publication.');
  return NextResponse.json(
    { mode: job.publishMode, publication: job.publication ? toPublicationDto(job.publication) : null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

const Body = z.object({
  action: z.enum(['approve', 'retry', 'cancel']),
  allowFork: z.boolean().optional(),
});

/** Approve, retry or cancel a publication. Server-side owner check; never trusts client state. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  if (!sameOrigin(req)) return forbiddenOrigin();
  const user = await currentUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Sign in with GitHub first.');
  const job = await prisma.resurrection.findUnique({ where: { id }, select: { ownerId: true } });
  if (!job || job.ownerId !== user.id) return jsonError(404, 'NOT_FOUND', 'No such publication.');
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return jsonError(400, 'INVALID_BODY', 'Expected { action: "approve" | "retry" | "cancel" }.');
  const conn = await prisma.githubConnection.findUnique({
    where: { userId: user.id },
    select: { status: true },
  });
  const result = await applyPublicationAction(prisma, id, body.data.action, {
    allowFork: body.data.allowFork,
    connectionActive: conn?.status === 'ACTIVE',
  });
  if (!result.ok) return jsonError(result.error!.http, result.error!.code, result.error!.message);
  return NextResponse.json({ ok: true, status: result.status });
}
