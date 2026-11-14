import { TERMINAL_STATUSES } from '@/engine/core/state';
import { jsonError, validJobId } from '@/server/api';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 700;
const KEEPALIVE_MS = 15_000;
const BATCH = 500;

/**
 * Server-Sent Events stream of a job's persisted events. Each message carries `id: <seq>`, so the
 * browser's automatic reconnect sends Last-Event-ID and resumes without loss or duplication.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validJobId(id)) return jsonError(400, 'INVALID_ID', 'Invalid resurrection id.');
  const exists = await prisma.resurrection.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return jsonError(404, 'NOT_FOUND', 'No such resurrection.');

  const url = new URL(req.url);
  const fromHeader = Number(req.headers.get('last-event-id'));
  const fromQuery = Number(url.searchParams.get('after'));
  let cursor =
    Number.isFinite(fromHeader) && fromHeader > 0
      ? fromHeader
      : Number.isFinite(fromQuery) && fromQuery > 0
        ? fromQuery
        : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      req.signal.addEventListener('abort', () => {
        closed = true;
      });
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      send('retry: 2000\n\n');
      let lastSend = Date.now();
      let terminalPolls = 0;

      try {
        while (!closed) {
          const events = await prisma.jobEvent.findMany({
            where: { resurrectionId: id, seq: { gt: cursor } },
            orderBy: { seq: 'asc' },
            take: BATCH,
          });
          let done = false;
          for (const e of events) {
            const payload = {
              seq: e.seq,
              type: e.type,
              level: e.level,
              message: e.message,
              data: e.data,
              ts: e.ts.toISOString(),
            };
            send(`id: ${e.seq}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
            cursor = e.seq;
            lastSend = Date.now();
            if (e.type === 'done') done = true;
          }
          if (done) {
            send('event: end\ndata: {}\n\n');
            break;
          }
          if (events.length === 0) {
            // Jobs that ended without a `done` event (e.g. interrupted worker) must still close the stream.
            const job = await prisma.resurrection.findUnique({ where: { id }, select: { status: true } });
            if (!job || TERMINAL_STATUSES.has(job.status)) {
              if (++terminalPolls >= 2) {
                send('event: end\ndata: {}\n\n');
                break;
              }
            }
            if (Date.now() - lastSend > KEEPALIVE_MS) {
              send(': keepalive\n\n');
              lastSend = Date.now();
            }
          }
          if (events.length < BATCH) await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } catch (err) {
        console.error('[sse] stream error', err);
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
