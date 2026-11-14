import type { Prisma, PrismaClient } from '@prisma/client';
import type { EventSink, PipelineEvent } from '@/engine/core/ports';

export const MAX_LINE_CHARS = 2000;
export const MAX_LOG_EVENTS = 20_000;

export interface StoredEvent {
  seq: number;
  type: PipelineEvent['type'];
  level: string;
  message: string;
  data: Record<string, unknown> | null;
}

/** Convert a pipeline event into the persisted shape (pure, testable). */
export function toStoredEvent(e: PipelineEvent, seq: number): StoredEvent {
  const message = e.message.length > MAX_LINE_CHARS ? e.message.slice(0, MAX_LINE_CHARS) + '…' : e.message;
  switch (e.type) {
    case 'log':
      return { seq, type: 'log', level: e.level, message, data: e.source ? { source: e.source } : null };
    case 'stage':
      return { seq, type: 'stage', level: 'info', message, data: { stage: e.stage } };
    case 'status':
      return { seq, type: 'status', level: 'info', message, data: { status: e.status, health: e.health } };
    case 'heartbeat':
      return { seq, type: 'heartbeat', level: 'info', message, data: { value: e.value } };
    case 'issue':
      return { seq, type: 'issue', level: 'warn', message, data: { issue: e.issue } };
    case 'attempt': {
      // Diffs can be large (lockfiles); the attempt row holds the full diff, events carry a summary.
      const { diff: _diff, ...summary } = e.attempt;
      return {
        seq,
        type: 'attempt',
        level: e.attempt.status === 'VERIFIED' || e.attempt.status === 'VERIFIED_STATIC' ? 'success' : 'warn',
        message,
        data: { attempt: JSON.parse(JSON.stringify(summary)) as Record<string, unknown> },
      };
    }
    case 'done':
      return { seq, type: 'done', level: 'info', message, data: { health: e.health } };
  }
}

/**
 * Persists events with a per-job monotonic sequence. Events are buffered and written in batches so
 * chatty installs do not issue one INSERT per line. Only one worker writes a given job.
 */
export class DbEventSink implements EventSink {
  private seq: number;
  private logCount = 0;
  private buffer: StoredEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: PrismaClient,
    private readonly jobId: string,
    startSeq = 0,
    private readonly flushMs = 250,
  ) {
    this.seq = startSeq;
  }

  emit(event: PipelineEvent): void {
    if (event.type === 'log') {
      if (this.logCount >= MAX_LOG_EVENTS) return;
      this.logCount++;
      if (this.logCount === MAX_LOG_EVENTS) {
        event = {
          ...event,
          level: 'warn',
          message: `Log limit of ${MAX_LOG_EVENTS} lines reached; further output is not stored.`,
        };
      }
    }
    this.buffer.push(toStoredEvent(event, ++this.seq));
    if (event.type !== 'log' || this.buffer.length >= 200) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return this.writing;
    this.writing = this.writing.then(() =>
      this.db.jobEvent
        .createMany({
          data: batch.map((e) => ({
            resurrectionId: this.jobId,
            seq: e.seq,
            type: e.type,
            level: e.level,
            message: e.message,
            data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
          })),
          skipDuplicates: true,
        })
        .then(() => undefined)
        .catch((err: unknown) =>
          console.error(`[events] failed to persist ${batch.length} events for ${this.jobId}`, err),
        ),
    );
    return this.writing;
  }
}
