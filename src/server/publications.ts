import type { Prisma, PrismaClient } from '@prisma/client';
import type { Health, StepName, StepResult } from '@/engine/core/types';
import { buildPrBody, prTitle } from '@/engine/publish/body';
import { partitionChanges, PublishError, type PublishChange } from '@/engine/publish/changes';
import type { GitHubApi } from '@/engine/publish/github-port';
import { evaluatePublishPolicy, type PublishModeName } from '@/engine/publish/policy';
import type { PublicationPatch, PublicationRecord, PublicationStore } from '@/engine/publish/publisher';
import {
  canTransition,
  isRetryable,
  MAX_PUBLISH_ATTEMPTS,
  type PublicationStatus,
} from '@/engine/publish/state';
import type { ResurrectionReport } from '@/engine/report';

const LOCK_STALE_MS = 5 * 60_000;
const ACTIVE_FOR_CONFLICT: PublicationStatus[] = [
  'PENDING_APPROVAL',
  'QUEUED',
  'AUTHORIZING',
  'PREPARING_BRANCH',
  'PUBLISHING_COMMIT',
  'CREATING_PR',
  'CREATED',
];

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export function branchNameFor(jobId: string): string {
  return `reporevive/fix-${jobId.slice(0, 10)}`;
}

export class PrismaPublicationStore implements PublicationStore {
  constructor(private readonly db: PrismaClient) {}

  async load(id: string): Promise<PublicationRecord | null> {
    const p = await this.db.publication.findUnique({ where: { id } });
    if (!p) return null;
    return {
      id: p.id,
      resurrectionId: p.resurrectionId,
      idempotencyKey: p.idempotencyKey,
      status: p.status,
      targetOwner: p.targetOwner,
      targetRepo: p.targetRepo,
      baseBranch: p.baseBranch,
      baseSha: p.baseSha,
      headOwner: p.headOwner,
      headRepo: p.headRepo,
      headBranch: p.headBranch,
      commitSha: p.commitSha,
      prNumber: p.prNumber,
      prUrl: p.prUrl,
      title: p.title,
      body: p.body,
      changes: p.changes as unknown as PublishChange[],
      allowFork: p.allowFork,
      attempts: p.attempts,
    };
  }

  async update(id: string, patch: PublicationPatch): Promise<void> {
    await this.db.publication.update({ where: { id }, data: patch });
  }

  /** Atomic claim: only one worker holds the lock; a crashed worker's lock expires. */
  async claim(id: string, workerId: string): Promise<boolean> {
    const stale = new Date(Date.now() - LOCK_STALE_MS);
    const r = await this.db.publication.updateMany({
      where: { id, OR: [{ lockedBy: null }, { lockedAt: { lt: stale } }, { lockedBy: workerId }] },
      data: { lockedBy: workerId, lockedAt: new Date() },
    });
    return r.count === 1;
  }

  async release(id: string, workerId: string): Promise<void> {
    await this.db.publication.updateMany({
      where: { id, lockedBy: workerId },
      data: { lockedBy: null, lockedAt: null },
    });
  }

  async hasConflictingActive(rec: PublicationRecord): Promise<boolean> {
    const n = await this.db.publication.count({
      where: {
        targetOwner: rec.targetOwner,
        targetRepo: rec.targetRepo,
        baseSha: rec.baseSha,
        resurrectionId: { not: rec.resurrectionId },
        status: { in: ACTIVE_FOR_CONFLICT },
      },
    });
    return n > 0;
  }
}

/** Append a `publication` event to the job's stream with a fresh monotonic seq (retries on races). */
export async function appendJobEvent(
  db: PrismaClient,
  jobId: string,
  e: { level: string; message: string; data?: Record<string, unknown> },
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.$executeRaw`
        INSERT INTO "JobEvent" ("resurrectionId", "seq", "type", "level", "message", "data", "ts")
        SELECT ${jobId}, COALESCE(MAX("seq"), 0) + 1, 'publication', ${e.level}, ${e.message.slice(0, 1000)}, ${JSON.stringify(e.data ?? {})}::jsonb, now()
        FROM "JobEvent" WHERE "resurrectionId" = ${jobId}`;
      return;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
}

export interface PublicationInput {
  jobId: string;
  ownerId: string;
  mode: PublishModeName;
  allowFork: boolean;
  allowPartial: boolean;
  health: Health;
  report: ResurrectionReport;
  changes: PublishChange[];
  baseSha: string | null;
  finalSteps: Record<StepName, Pick<StepResult, 'status' | 'skipReason'>> | null;
  reportUrl: string | null;
}

/**
 * Create the (single) publication row for a finished job. Idempotent: an existing row is returned untouched.
 * Policy denial is stored as BLOCKED with the reasons so the UI can explain it; patch download stays available.
 */
export async function createPublication(
  db: PrismaClient,
  api: GitHubApi | null,
  i: PublicationInput,
): Promise<{ id: string; status: PublicationStatus } | null> {
  if (i.mode === 'PATCH_ONLY') return null;
  const existing = await db.publication.findUnique({
    where: { resurrectionId: i.jobId },
    select: { id: true, status: true },
  });
  if (existing) return existing;

  let publishable: PublishChange[] = [];
  let excluded: { path: string; reason: string }[] = [];
  let partitionError: string | null = null;
  try {
    ({ publishable, excluded } = partitionChanges(i.changes));
  } catch (err) {
    partitionError = err instanceof PublishError ? err.message : 'The change set cannot be published.';
  }

  let baseBranch = 'main';
  let lookupError: string | null = null;
  const target = { owner: i.report.repo.owner, name: i.report.repo.name };
  if (api) {
    try {
      const repo = await api.getRepo(target.owner, target.name);
      if (!repo) lookupError = 'The repository is not accessible with your GitHub authorization.';
      else baseBranch = repo.defaultBranch;
    } catch (err) {
      lookupError = err instanceof PublishError ? err.message : 'Could not reach GitHub.';
    }
  } else lookupError = 'GitHub is not connected.';

  const policy = evaluatePublishPolicy({
    mode: i.mode,
    actorUserId: i.ownerId,
    jobOwnerId: i.ownerId,
    approved: i.mode === 'AUTO_PR',
    autoEnabledAtSubmission: i.mode === 'AUTO_PR',
    health: i.health,
    allowPartial: i.allowPartial,
    finalSteps: i.finalSteps,
    publishableFiles: publishable.length,
    baseKnown: Boolean(i.baseSha),
  });
  // REVIEW_PR still needs the user's approval click; everything else must already pass.
  const reasons = policy.reasons.filter((r) => !(i.mode === 'REVIEW_PR' && /not been approved/.test(r)));
  if (partitionError) reasons.push(partitionError);
  if (lookupError) reasons.push(lookupError);
  const ok = reasons.length === 0;
  const status: PublicationStatus = !ok ? 'BLOCKED' : i.mode === 'AUTO_PR' ? 'QUEUED' : 'PENDING_APPROVAL';

  const row = await db.publication.create({
    data: {
      resurrectionId: i.jobId,
      idempotencyKey: `reporevive:${i.jobId}`,
      mode: i.mode,
      status,
      targetOwner: target.owner,
      targetRepo: target.name,
      baseBranch,
      baseSha: i.baseSha ?? '',
      headBranch: branchNameFor(i.jobId),
      title: prTitle(i.report),
      body: buildPrBody({ report: i.report, baseBranch, excluded, reportUrl: i.reportUrl, jobId: i.jobId }),
      changes: toJson(publishable),
      excluded: toJson(excluded),
      allowFork: i.allowFork,
      lastError: ok ? null : reasons.join(' '),
      lastErrorCode: ok ? null : 'POLICY',
    },
    select: { id: true, status: true },
  });
  await appendJobEvent(db, i.jobId, {
    level: ok ? 'info' : 'warn',
    message: ok
      ? status === 'QUEUED'
        ? 'Automatic pull request queued.'
        : 'Verified diff ready. Approve it to open a draft pull request.'
      : `Pull request not created: ${reasons.join(' ')}`,
    data: { status },
  }).catch(() => undefined);
  return row;
}

export type PublicationAction = 'approve' | 'retry' | 'cancel';

export interface ActionResult {
  ok: boolean;
  status?: PublicationStatus;
  error?: { code: string; message: string; http: number };
}

/** User actions on an existing publication. Ownership is checked by the caller; state rules are enforced here. */
export async function applyPublicationAction(
  db: PrismaClient,
  jobId: string,
  action: PublicationAction,
  opts: { allowFork?: boolean; connectionActive: boolean },
): Promise<ActionResult> {
  const p = await db.publication.findUnique({ where: { resurrectionId: jobId } });
  if (!p)
    return {
      ok: false,
      error: { code: 'NO_PUBLICATION', message: 'No publication exists for this job.', http: 404 },
    };
  const deny = (code: string, message: string, http = 409): ActionResult => ({
    ok: false,
    error: { code, message, http },
  });
  const move = async (to: PublicationStatus, data: Prisma.PublicationUpdateManyMutationInput = {}) => {
    if (!canTransition(p.status, to)) return deny('INVALID_STATE', `Cannot move from ${p.status} to ${to}.`);
    // Compare-and-set so two simultaneous clicks queue it once.
    const r = await db.publication.updateMany({
      where: { id: p.id, status: p.status },
      data: { status: to, ...data },
    });
    if (r.count !== 1) return deny('RACE', 'The publication changed; refresh and try again.');
    await appendJobEvent(db, jobId, {
      level: 'info',
      message: `Publication ${to.toLowerCase()}.`,
      data: { status: to },
    }).catch(() => undefined);
    return { ok: true, status: to } as ActionResult;
  };
  if (action === 'approve') {
    if (p.status !== 'PENDING_APPROVAL') return deny('INVALID_STATE', 'Nothing is waiting for approval.');
    if (!opts.connectionActive) return deny('AUTH_REQUIRED', 'Reconnect your GitHub account first.', 401);
    return move('QUEUED', { allowFork: Boolean(opts.allowFork), lastError: null, lastErrorCode: null });
  }
  if (action === 'retry') {
    if (!isRetryable(p.status)) return deny('INVALID_STATE', 'This publication cannot be retried.');
    if (p.attempts >= MAX_PUBLISH_ATTEMPTS)
      return deny('RETRY_LIMIT', 'The retry limit was reached. Download the patch and apply it manually.');
    if (!opts.connectionActive) return deny('AUTH_REQUIRED', 'Reconnect your GitHub account first.', 401);
    return move('QUEUED', { allowFork: opts.allowFork ?? p.allowFork, lastError: null, lastErrorCode: null });
  }
  return move('CANCELLED');
}

export interface PublicationDto {
  status: PublicationStatus;
  mode: string;
  target: string;
  baseBranch: string;
  head: string | null;
  headBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  isDraft: boolean;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  allowFork: boolean;
  excluded: { path: string; reason: string }[];
  files: string[];
  title: string;
  retryable: boolean;
}

export function toPublicationDto(p: {
  status: PublicationStatus;
  mode: string;
  targetOwner: string;
  targetRepo: string;
  baseBranch: string;
  headOwner: string | null;
  headRepo: string | null;
  headBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  isDraft: boolean;
  attempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  allowFork: boolean;
  excluded: unknown;
  changes: unknown;
  title: string;
}): PublicationDto {
  return {
    status: p.status,
    mode: p.mode,
    target: `${p.targetOwner}/${p.targetRepo}`,
    baseBranch: p.baseBranch,
    head: p.headOwner && p.headRepo ? `${p.headOwner}/${p.headRepo}` : null,
    headBranch: p.headBranch,
    prNumber: p.prNumber,
    prUrl: p.prUrl,
    isDraft: p.isDraft,
    attempts: p.attempts,
    maxAttempts: MAX_PUBLISH_ATTEMPTS,
    lastError: p.lastError,
    lastErrorCode: p.lastErrorCode,
    allowFork: p.allowFork,
    excluded: Array.isArray(p.excluded) ? (p.excluded as { path: string; reason: string }[]) : [],
    files: Array.isArray(p.changes) ? (p.changes as { path: string }[]).map((c) => c.path) : [],
    title: p.title,
    retryable: isRetryable(p.status) && p.attempts < MAX_PUBLISH_ATTEMPTS,
  };
}
