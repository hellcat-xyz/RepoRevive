import { NextResponse } from 'next/server';
import { jsonError, validJobId } from '@/server/api';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const job = await prisma.resurrection.findUnique({ where: { id }, select: { status: true } });
  if (!job) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');
  if (job.status === 'QUEUED') {
    // Not picked up yet: cancel directly (a worker only claims QUEUED jobs).
    await prisma.resurrection.updateMany({
      where: { id, status: 'QUEUED', lockedBy: null },
      data: { status: 'CANCELLED', health: 'UNRECOVERABLE', cancelRequested: true, finishedAt: new Date() },
    });
  } else {
    await prisma.resurrection.update({ where: { id }, data: { cancelRequested: true } });
  }
  return NextResponse.json({ ok: true });
}
