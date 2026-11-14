import type { RepairAttempt, Resurrection } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { AttemptRecord } from '@/engine/core/types';
import type { ResurrectionReport } from '@/engine/report';
import type { JobSnapshot, JobSummary } from '@/lib/types';
import { JOB_ID_RE } from '@/lib/types';

export function jsonError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function validJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

const MAX_DIFF_CHARS = 200_000;

export function toAttempt(a: RepairAttempt): AttemptRecord {
  return {
    seq: a.seq,
    issueKind: a.issueKind as AttemptRecord['issueKind'],
    fingerprint: a.fingerprint,
    strategyId: a.strategyId,
    title: a.title,
    rationale: a.rationale,
    status: a.status,
    reason: a.reason ?? undefined,
    files: a.files,
    diff: a.diff
      ? a.diff.length > MAX_DIFF_CHARS
        ? a.diff.slice(0, MAX_DIFF_CHARS) + '\n… diff truncated; download the patch for the full content …\n'
        : a.diff
      : undefined,
    verification: (a.verification ?? undefined) as AttemptRecord['verification'],
    durationMs: a.durationMs,
  };
}

export function toSnapshot(job: Resurrection & { attempts: RepairAttempt[] }): JobSnapshot {
  return {
    id: job.id,
    repoUrl: job.repoUrl,
    owner: job.owner,
    name: job.name,
    status: job.status,
    health: job.health,
    heartbeat: job.heartbeat,
    currentStage: (job.currentStage as JobSnapshot['currentStage']) ?? null,
    commitSha: job.commitSha,
    commitDate: job.commitDate?.toISOString() ?? null,
    runtime: job.runtime,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    report: (job.report ?? null) as ResurrectionReport | null,
    attempts: job.attempts.sort((x, y) => x.seq - y.seq).map(toAttempt),
    hasPatch: Boolean(job.patch && job.patch.length > 0),
  };
}

export function toSummary(
  job: Pick<
    Resurrection,
    'id' | 'owner' | 'name' | 'status' | 'health' | 'heartbeat' | 'createdAt' | 'finishedAt'
  >,
): JobSummary {
  return {
    id: job.id,
    owner: job.owner,
    name: job.name,
    status: job.status,
    health: job.health,
    heartbeat: job.heartbeat,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
