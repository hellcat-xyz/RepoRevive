import { jsonError, validJobId } from '@/server/api';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const job = await prisma.resurrection.findUnique({
    where: { id },
    select: { owner: true, name: true, patch: true, commitSha: true },
  });
  if (!job) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');
  if (!job.patch) return jsonError(404, 'NO_PATCH', 'This resurrection produced no verified changes.');
  const filename = `${job.owner}-${job.name}-revived.patch`.replace(/[^A-Za-z0-9._-]/g, '_');
  const header = `RepoRevive verified patch for ${job.owner}/${job.name}${job.commitSha ? ` @ ${job.commitSha}` : ''}\nApply with: git apply ${filename}\n\n`;
  return new Response(header + job.patch, {
    headers: {
      'content-type': 'text/x-patch; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
