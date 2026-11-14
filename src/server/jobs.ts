import type { Prisma, PrismaClient } from '@prisma/client';
import type { AttemptRecord, JobStatus } from '@/engine/core/types';
import type { JobReporter, JobUpdate } from '@/engine/pipeline';
import { TERMINAL_STATUSES } from '@/engine/core/state';

const RUNNING_STATUSES = [
  'CLONING',
  'ANALYZING',
  'BASELINE',
  'DIAGNOSING',
  'REPAIRING',
  'VERIFYING',
  'REPORTING',
] as const;

function json(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
}

export async function createJob(
  db: PrismaClient,
  input: { repoUrl: string; owner: string; name: string; clientIp: string | null },
) {
  return db.resurrection.create({
    data: { repoUrl: input.repoUrl, owner: input.owner, name: input.name, clientIp: input.clientIp },
    select: { id: true },
  });
}

/** Atomically claim the oldest queued job. Safe with many workers (row lock + SKIP LOCKED). */
export async function claimNextJob(db: PrismaClient, workerId: string): Promise<{ id: string } | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Resurrection" SET "lockedBy" = ${workerId}, "lockedAt" = now(), "startedAt" = now(), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "Resurrection"
      WHERE status = 'QUEUED' AND "lockedBy" IS NULL
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  return rows[0] ?? null;
}

/** Heartbeat the lock so other workers can tell this job is alive. */
export async function touchLock(db: PrismaClient, jobId: string, workerId: string) {
  await db.resurrection.updateMany({
    where: { id: jobId, lockedBy: workerId },
    data: { lockedAt: new Date() },
  });
}

/** Jobs whose worker died mid-run are failed, never silently resumed (partial sandbox state is untrusted). */
export async function failStaleJobs(db: PrismaClient, staleAfterMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const res = await db.resurrection.updateMany({
    where: { status: { in: [...RUNNING_STATUSES] }, OR: [{ lockedAt: { lt: cutoff } }, { lockedAt: null }] },
    data: {
      status: 'FAILED',
      health: 'UNRECOVERABLE',
      errorCode: 'WORKER_INTERRUPTED',
      errorMessage: 'The worker stopped while this resurrection was running. Please start it again.',
      finishedAt: new Date(),
    },
  });
  // Claimed but never started: release back to the queue.
  await db.resurrection.updateMany({
    where: { status: 'QUEUED', lockedBy: { not: null }, lockedAt: { lt: cutoff } },
    data: { lockedBy: null, lockedAt: null },
  });
  return res.count;
}

export async function maxEventSeq(db: PrismaClient, jobId: string): Promise<number> {
  const r = await db.jobEvent.aggregate({ where: { resurrectionId: jobId }, _max: { seq: true } });
  return r._max.seq ?? 0;
}

export class PrismaJobReporter implements JobReporter {
  constructor(
    private readonly db: PrismaClient,
    private readonly jobId: string,
  ) {}

  async update(f: JobUpdate): Promise<void> {
    const data: Prisma.ResurrectionUpdateInput = {
      status: f.status,
      health: f.health,
      heartbeat: f.heartbeat === undefined ? undefined : Math.round(f.heartbeat),
      currentStage: f.currentStage,
      commitSha: f.commitSha,
      commitDate: f.commitDate,
      runtime: f.runtime,
      analysis: json(f.analysis),
      baseline: json(f.baseline),
      final: json(f.final),
      report: json(f.report),
      patch: f.patch,
      errorCode: f.errorCode,
      errorMessage: f.errorMessage,
    };
    if (f.status && TERMINAL_STATUSES.has(f.status as JobStatus)) {
      data.finishedAt = new Date();
      data.lockedBy = null;
    }
    await this.db.resurrection.update({ where: { id: this.jobId }, data });
  }

  async saveAttempt(a: AttemptRecord): Promise<void> {
    await this.db.repairAttempt.create({
      data: {
        resurrectionId: this.jobId,
        seq: a.seq,
        issueKind: a.issueKind,
        fingerprint: a.fingerprint,
        strategyId: a.strategyId,
        title: a.title,
        rationale: a.rationale,
        status: a.status,
        reason: a.reason,
        files: a.files,
        diff: a.diff,
        verification: json(a.verification),
        durationMs: Math.round(a.durationMs),
      },
    });
  }
}
