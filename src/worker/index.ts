import { hostname } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { HttpNpmRegistry } from '@/engine/ecosystems/npm/registry-http';
import { OpenAiCompatibleClient } from '@/engine/llm/openai-client';
import { ResurrectionPipeline } from '@/engine/pipeline';
import { parseGitHubUrl } from '@/lib/github';
import { DockerSandbox } from '@/sandbox/docker-sandbox';
import { config } from '@/server/config';
import { prisma } from '@/server/db';
import { DbEventSink } from '@/server/event-sink';
import { claimNextJob, failStaleJobs, maxEventSeq, PrismaJobReporter, touchLock } from '@/server/jobs';

const cfg = config();
const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
const POLL_MS = 1500;
const LOCK_TOUCH_MS = 30_000;
const STALE_AFTER_MS = 3 * 60_000;

const running = new Map<string, Promise<void>>();
let stopping = false;

const registry = new HttpNpmRegistry();
const llm = cfg.llm ? new OpenAiCompatibleClient(cfg.llm) : null;

async function runJob(jobId: string): Promise<void> {
  const job = await prisma.resurrection.findUniqueOrThrow({ where: { id: jobId } });
  const parsed = parseGitHubUrl(job.repoUrl);
  const reporter = new PrismaJobReporter(prisma, jobId);
  if (!parsed.ok) {
    await reporter.update({
      status: 'FAILED',
      health: 'UNRECOVERABLE',
      errorCode: 'INVALID_URL',
      errorMessage: parsed.error,
    });
    return;
  }

  const jobDir = path.join(cfg.dataDir, 'jobs', jobId);
  const sandbox = new DockerSandbox({ jobId, ...cfg.sandbox });
  const sink = new DbEventSink(prisma, jobId, await maxEventSeq(prisma, jobId));
  const lockTimer = setInterval(
    () => void touchLock(prisma, jobId, workerId).catch(() => undefined),
    LOCK_TOUCH_MS,
  );

  const pipeline = new ResurrectionPipeline(
    {
      sandbox,
      registry,
      llm,
      sink,
      reporter,
      isCancelled: async () =>
        stopping ||
        Boolean(
          (await prisma.resurrection.findUnique({ where: { id: jobId }, select: { cancelRequested: true } }))
            ?.cancelRequested,
        ),
    },
    {
      maxAttempts: cfg.maxAttempts,
      jobTimeoutMs: cfg.jobTimeoutMs,
      cloneTimeoutMs: cfg.cloneTimeoutMs,
      timeouts: cfg.timeouts,
      networkForBuild: cfg.networkForBuild,
    },
  );

  try {
    const outcome = await pipeline.run({ jobId, repo: parsed.repo, jobDir });
    console.info(
      `[worker] ${jobId} ${parsed.repo.owner}/${parsed.repo.name}: ${outcome.status} / ${outcome.health}`,
    );
  } catch (err) {
    console.error(`[worker] ${jobId} crashed`, err);
    await reporter
      .update({
        status: 'FAILED',
        health: 'UNRECOVERABLE',
        errorCode: 'INTERNAL',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
  } finally {
    clearInterval(lockTimer);
    await sink.flush();
    await sandbox.reap().catch(() => undefined);
    await sandbox.removeDir(jobDir);
  }
}

async function loop() {
  while (!stopping) {
    try {
      while (running.size < cfg.workerConcurrency && !stopping) {
        const claimed = await claimNextJob(prisma, workerId);
        if (!claimed) break;
        console.info(`[worker] claimed ${claimed.id}`);
        const p = runJob(claimed.id).finally(() => running.delete(claimed.id));
        running.set(claimed.id, p);
      }
    } catch (err) {
      console.error('[worker] poll failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main() {
  await DockerSandbox.assertAvailable();
  await fs.mkdir(path.join(cfg.dataDir, 'jobs'), { recursive: true });
  const stale = await failStaleJobs(prisma, STALE_AFTER_MS);
  if (stale) console.warn(`[worker] marked ${stale} interrupted job(s) as failed`);
  console.info(
    `[worker] ${workerId} ready (concurrency ${cfg.workerConcurrency}, AI strategy ${llm ? 'on' : 'off'})`,
  );
  await loop();
}

async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  console.info(`[worker] ${signal} received; cancelling ${running.size} running job(s)…`);
  await Promise.race([Promise.allSettled(running.values()), new Promise((r) => setTimeout(r, 60_000))]);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (err) => {
  console.error('[worker] fatal', err);
  await prisma.$disconnect();
  process.exit(1);
});
