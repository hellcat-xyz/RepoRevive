import { NextResponse } from 'next/server';
import { jsonError, toSnapshot, validJobId } from '@/server/api';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const job = await prisma.resurrection.findUnique({ where: { id }, include: { attempts: true } });
  if (!job) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');
  return NextResponse.json(toSnapshot(job), { headers: { 'cache-control': 'no-store' } });
}
