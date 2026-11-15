import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, toSnapshot, validJobId } from '@/server/api';
import { canView, currentUser } from '@/server/auth';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const job = await prisma.resurrection.findUnique({ where: { id }, include: { attempts: true } });
  // Owned jobs answer 404 to everyone else so their existence is not disclosed.
  const user = await currentUser(req);
  if (!job || !canView(job, user)) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');
  return NextResponse.json(toSnapshot(job, user?.id ?? null), { headers: { 'cache-control': 'no-store' } });
}
