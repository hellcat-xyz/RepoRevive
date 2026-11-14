import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ResurrectionPipeline } from '@/engine/pipeline';
import { toSnapshot } from '@/server/api';
import { DbEventSink } from '@/server/event-sink';
import { claimNextJob, createJob, failStaleJobs, PrismaJobReporter } from '@/server/jobs';
import { fakeClock, FakeRegistry, FakeSandbox, makeRepo } from '../helpers/fake-world';

/**
 * Opt-in: needs PostgreSQL with migrations applied.
 * REPOREVIVE_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/integration/db.test.ts
 */
const enabled = process.env.REPOREVIVE_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

describe.runIf(enabled)('database-backed pipeline', () => {
  const db = enabled ? new PrismaClient() : (null as unknown as PrismaClient);
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('claims a job once, persists ordered events, attempts, report, and patch', async () => {
    const job = await createJob(db, {
      repoUrl: 'https://github.com/ghost/sass-site',
      owner: 'ghost',
      name: 'sass-site',
      clientIp: 'test',
    });
    const claimed: string[] = [];
    // Two concurrent claimers must not both get the same job.
    const [a, b] = await Promise.all([claimNextJob(db, 'w1'), claimNextJob(db, 'w2')]);
    for (const c of [a, b]) if (c) claimed.push(c.id);
    expect(claimed.filter((id) => id === job.id)).toHaveLength(1);

    const nodeSassLog = readFileSync(path.join(__dirname, '..', 'fixtures', 'node-sass-gyp.log'), 'utf8');
    const repo = await makeRepo({
      'package.json':
        JSON.stringify(
          { name: 'sass-site', scripts: { build: 'webpack' }, dependencies: { 'node-sass': '^4.14.1' } },
          null,
          2,
        ) + '\n',
    });
    const sandbox = new FakeSandbox((v) => {
      if (v.label === 'install' && v.deps()['node-sass'] && v.major > 14)
        return { exitCode: 1, output: nodeSassLog };
      return { exitCode: 0, output: 'ok' };
    });
    const sink = new DbEventSink(db, job.id, 0, 10);
    const outcome = await new ResurrectionPipeline(
      {
        sandbox,
        registry: new FakeRegistry({}),
        llm: null,
        sink,
        reporter: new PrismaJobReporter(db, job.id),
        clock: fakeClock(),
      },
      {
        maxAttempts: 5,
        jobTimeoutMs: 3_600_000,
        cloneTimeoutMs: 1000,
        timeouts: { install: 1000, build: 1000, test: 1000 },
        networkForBuild: false,
      },
    ).run({
      jobId: job.id,
      repo: { owner: 'ghost', name: 'sass-site', url: 'https://github.com/ghost/sass-site' },
      jobDir: repo.jobDir,
      preCloned: { commitSha: 'c'.repeat(40), commitDate: '2020-05-01T00:00:00Z' },
    });
    await repo.cleanup();
    expect(outcome.health).toBe('REVIVED');

    const row = await db.resurrection.findUniqueOrThrow({
      where: { id: job.id },
      include: { attempts: true },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.health).toBe('REVIVED');
    expect(row.heartbeat).toBe(100);
    expect(row.finishedAt).not.toBeNull();
    expect(row.lockedBy).toBeNull();
    expect(row.patch).toContain('b/.nvmrc');

    const events = await db.jobEvent.findMany({ where: { resurrectionId: job.id }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)?.type).toBe('done');

    const snap = toSnapshot(row);
    expect(snap.attempts[0]?.status).toBe('VERIFIED');
    expect(snap.report?.health).toBe('REVIVED');
    expect(snap.hasPatch).toBe(true);
  });

  it('fails stale running jobs on worker restart', async () => {
    const job = await createJob(db, {
      repoUrl: 'https://github.com/ghost/stale',
      owner: 'ghost',
      name: 'stale',
      clientIp: null,
    });
    await db.resurrection.update({
      where: { id: job.id },
      data: { status: 'REPAIRING', lockedBy: 'dead-worker', lockedAt: new Date(Date.now() - 3_600_000) },
    });
    expect(await failStaleJobs(db, 60_000)).toBeGreaterThanOrEqual(1);
    const row = await db.resurrection.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('WORKER_INTERRUPTED');
  });
});
