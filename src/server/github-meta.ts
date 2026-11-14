import { z } from 'zod';
import { ResurrectionError } from '@/engine/core/errors';
import type { RepoRef } from '@/lib/github';

const RepoSchema = z.object({
  private: z.boolean(),
  archived: z.boolean().optional(),
  size: z.number(), // KB
  default_branch: z.string().optional(),
  pushed_at: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  language: z.string().nullable().optional(),
});

export type RepoMeta = z.infer<typeof RepoSchema>;

/**
 * Check that the repository exists, is public, and is within the size limit before queueing.
 * If the GitHub API is unreachable or rate-limited we return null and let the clone decide.
 */
export async function checkRepository(
  repo: RepoRef,
  opts: { token: string | null; maxSizeMb: number },
): Promise<RepoMeta | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'RepoRevive',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (res.status === 404) {
    throw new ResurrectionError(
      'REPO_NOT_FOUND_OR_PRIVATE',
      'Repository not found. It may be private, and private repositories are not supported yet.',
    );
  }
  if (!res.ok) return null;
  const parsed = RepoSchema.safeParse(await res.json());
  if (!parsed.success) return null;
  if (parsed.data.private) {
    throw new ResurrectionError(
      'REPO_NOT_FOUND_OR_PRIVATE',
      'This repository is private. Private repositories are not supported yet.',
    );
  }
  if (parsed.data.size / 1024 > opts.maxSizeMb) {
    throw new ResurrectionError(
      'REPO_TOO_LARGE',
      `Repository is ${Math.round(parsed.data.size / 1024)} MB; the limit is ${opts.maxSizeMb} MB.`,
    );
  }
  return parsed.data;
}
