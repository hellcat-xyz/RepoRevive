import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ResurrectionError } from '@/engine/core/errors';
import { parseGitHubUrl } from '@/lib/github';
import { jsonError, toSummary } from '@/server/api';
import { config } from '@/server/config';
import { prisma } from '@/server/db';
import { checkRepository } from '@/server/github-meta';
import { createJob } from '@/server/jobs';
import { clientIp, RateLimiter } from '@/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ url: z.string().min(1).max(300) });

const globalForLimiter = globalThis as unknown as { rrLimiter?: RateLimiter };

function limiter(): RateLimiter {
  globalForLimiter.rrLimiter ??= new RateLimiter(config().rateLimitPerMinute);
  return globalForLimiter.rrLimiter;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const rl = limiter().check(ip);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many resurrections. Let the dead rest a moment.', {
      'retry-after': String(rl.retryAfterSec),
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Expected a JSON body.');
  }
  const parsedBody = BodySchema.safeParse(body);
  if (!parsedBody.success) return jsonError(400, 'INVALID_BODY', 'Expected { "url": string }.');

  const parsed = parseGitHubUrl(parsedBody.data.url);
  if (!parsed.ok) return jsonError(400, 'INVALID_URL', parsed.error);

  try {
    const cfg = config();
    await checkRepository(parsed.repo, { token: cfg.githubToken, maxSizeMb: cfg.maxRepoSizeMb });
  } catch (err) {
    if (err instanceof ResurrectionError) {
      const status =
        err.code === 'REPO_TOO_LARGE' ? 413 : err.code === 'REPO_NOT_FOUND_OR_PRIVATE' ? 404 : 400;
      return jsonError(status, err.code, err.message);
    }
    throw err;
  }

  const job = await createJob(prisma, {
    repoUrl: parsed.repo.url,
    owner: parsed.repo.owner,
    name: parsed.repo.name,
    clientIp: ip,
  });
  return NextResponse.json({ id: job.id }, { status: 201 });
}

export async function GET() {
  const jobs = await prisma.resurrection.findMany({
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: {
      id: true,
      owner: true,
      name: true,
      status: true,
      health: true,
      heartbeat: true,
      createdAt: true,
      finishedAt: true,
    },
  });
  return NextResponse.json({ jobs: jobs.map(toSummary) }, { headers: { 'cache-control': 'no-store' } });
}
