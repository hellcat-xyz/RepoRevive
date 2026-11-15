import type { PrismaClient } from '@prisma/client';
import { PublishError, type PublishChange } from '@/engine/publish/changes';
import { GitHubRest } from '@/engine/publish/github-rest';
import { runPublication } from '@/engine/publish/publisher';
import type { PipelineOutcome } from '@/engine/pipeline';
import type { GithubAppConfig } from './config';
import { getAccessToken } from './github/connection';
import { appendJobEvent, createPublication, PrismaPublicationStore } from './publications';

/** After a job finishes: create its publication row (REVIEW_PR waits for approval, AUTO_PR is queued). Never throws. */
export async function afterJob(
  db: PrismaClient,
  cfg: GithubAppConfig | null,
  jobId: string,
  outcome: PipelineOutcome,
) {
  try {
    const job = await db.resurrection.findUnique({
      where: { id: jobId },
      select: {
        ownerId: true,
        publishMode: true,
        allowPartialPublish: true,
        allowForkPublish: true,
        commitSha: true,
      },
    });
    if (!job || job.publishMode === 'PATCH_ONLY') return;
    if (!job.ownerId || !cfg) {
      await appendJobEvent(db, jobId, {
        level: 'warn',
        message: 'Pull request skipped: GitHub is not connected for this job.',
      });
      return;
    }
    let api: GitHubRest | null = null;
    try {
      const token = await getAccessToken(db, cfg, job.ownerId);
      api = new GitHubRest({ getToken: () => token });
    } catch {
      api = null;
    }
    const changes: PublishChange[] = (outcome.workspace?.changes() ?? []).map((c) => ({
      path: c.path,
      before: c.before,
      after: c.after,
    }));
    const steps = outcome.report.verification.final?.steps ?? null;
    await createPublication(db, api, {
      jobId,
      ownerId: job.ownerId,
      mode: job.publishMode,
      allowFork: job.allowForkPublish,
      allowPartial: job.allowPartialPublish,
      health: outcome.health,
      report: outcome.report,
      changes,
      baseSha: job.commitSha,
      finalSteps: steps,
      reportUrl: `${cfg.baseUrl}/r/${jobId}`,
    });
  } catch (err) {
    console.error(
      `[publish] could not create publication for ${jobId}`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Run queued publications (and resume ones whose worker died). Safe to call from several workers. */
export async function processPublications(
  db: PrismaClient,
  cfg: GithubAppConfig | null,
  workerId: string,
  limit = 3,
) {
  if (!cfg) return;
  const staleLock = new Date(Date.now() - 5 * 60_000);
  const rows = await db.publication.findMany({
    where: {
      OR: [
        { status: 'QUEUED' },
        {
          status: { in: ['AUTHORIZING', 'PREPARING_BRANCH', 'PUBLISHING_COMMIT', 'CREATING_PR'] },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLock } }],
        },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: {
      id: true,
      resurrectionId: true,
      resurrection: { select: { ownerId: true, ownerUser: { select: { login: true } } } },
    },
  });
  const store = new PrismaPublicationStore(db);
  for (const row of rows) {
    const ownerId = row.resurrection.ownerId;
    const login = row.resurrection.ownerUser?.login;
    const emit = (e: { level: string; message: string; data?: Record<string, unknown> }) =>
      void appendJobEvent(db, row.resurrectionId, e).catch(() => undefined);
    if (!ownerId || !login) {
      await db.publication.update({
        where: { id: row.id },
        data: { status: 'BLOCKED', lastError: 'The job has no GitHub owner.', lastErrorCode: 'POLICY' },
      });
      continue;
    }
    let token: string;
    try {
      token = await getAccessToken(db, cfg, ownerId);
    } catch (err) {
      const pe = err instanceof PublishError ? err : null;
      await db.publication.update({
        where: { id: row.id },
        data: {
          status: pe?.retryable ? 'FAILED' : 'AUTH_EXPIRED',
          lastError: pe?.message ?? 'Could not obtain GitHub credentials.',
          lastErrorCode: pe?.code ?? 'AUTH_EXPIRED',
        },
      });
      emit({
        level: 'error',
        message: pe?.message ?? 'GitHub credentials are unavailable.',
        data: { status: 'AUTH_EXPIRED' },
      });
      continue;
    }
    const outcome = await runPublication(
      { store, api: new GitHubRest({ getToken: () => token }), expectedLogin: login, workerId, emit },
      row.id,
    );
    console.info(`[publish] ${row.id}: ${outcome.status}`);
  }
}
