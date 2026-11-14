import { reportToMarkdown, type ResurrectionReport } from '@/engine/report';
import { jsonError, validJobId } from '@/server/api';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const format = new URL(req.url).searchParams.get('format') === 'json' ? 'json' : 'md';
  const job = await prisma.resurrection.findUnique({
    where: { id },
    select: { owner: true, name: true, report: true },
  });
  if (!job) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');
  if (!job.report) return jsonError(409, 'NOT_READY', 'The report is not ready yet.');
  const base = `${job.owner}-${job.name}-resurrection-report`.replace(/[^A-Za-z0-9._-]/g, '_');
  const report = job.report as unknown as ResurrectionReport;
  const body = format === 'json' ? JSON.stringify(report, null, 2) : reportToMarkdown(report);
  return new Response(body, {
    headers: {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${base}.${format}"`,
      'cache-control': 'no-store',
    },
  });
}
