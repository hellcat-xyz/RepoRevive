import { z } from 'zod';
import type { UpstreamResolver } from '../core/ports';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]{1,100}$/;
const REF = /^[\w./-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const PATH = /^[\w@.+/-]{1,300}$/;

export function isSafeGitHubOwner(s: string): boolean {
  return OWNER.test(s);
}
export function isSafeGitHubRepo(s: string): boolean {
  return REPO.test(s) && s !== '.' && s !== '..';
}
export function isSafeGitRef(s: string): boolean {
  return REF.test(s) && !s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}
export function isSafeRepoPath(s: string): boolean {
  return PATH.test(s) && !s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}
export function isCommitSha(s: string): boolean {
  return SHA.test(s);
}

const CommitsSchema = z.array(z.object({ sha: z.string().regex(SHA) }));
const ContentSchema = z.object({ type: z.literal('file') });

const API_HOST = 'api.github.com';

/**
 * Host-side GitHub client for upstream lookups. It talks only to api.github.com only, validates every URL component, bounds each request, and refuses
 * responses that were redirected to another host. The optional token is sent to api.github.com only.
 */
export class GitHubUpstreamResolver implements UpstreamResolver {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: { token?: string | null; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  private memo<T>(key: string, f: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = f();
      this.cache.set(key, p);
    }
    return p;
  }

  private async get(url: URL, init: RequestInit): Promise<Response> {
    if (url.protocol !== 'https:' || url.hostname !== API_HOST)
      throw new Error(`Refusing request to ${url.hostname}`);
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response | undefined;
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      try {
        res = await f(url, {
          ...init,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
          headers: {
            'user-agent': 'RepoRevive',
            ...(url.hostname === API_HOST && this.opts.token
              ? { authorization: `Bearer ${this.opts.token}` }
              : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        });
      } catch (err) {
        // Transient connect/timeout failures happen against GitHub's CDN; retry a couple of times.
        if (attempt === 3) throw err;
      }
    }
    if (!res) throw new Error('Upstream request failed');
    if (res.url && new URL(res.url).hostname !== url.hostname)
      throw new Error('Upstream request was redirected to another host');
    return res;
  }

  commitAt(owner: string, repo: string, ref: string, untilIso: string): Promise<string | null> {
    if (!isSafeGitHubOwner(owner) || !isSafeGitHubRepo(repo) || !isSafeGitRef(ref))
      return Promise.resolve(null);
    const until = new Date(untilIso);
    if (Number.isNaN(until.getTime())) return Promise.resolve(null);
    const iso = until.toISOString();
    return this.memo(`c:${owner}/${repo}@${ref}<=${iso}`, async () => {
      const url = new URL(`https://${API_HOST}/repos/${owner}/${repo}/commits`);
      url.searchParams.set('sha', ref);
      url.searchParams.set('until', iso);
      url.searchParams.set('per_page', '1');
      const res = await this.get(url, { headers: { accept: 'application/vnd.github+json' } });
      if (res.status === 404 || res.status === 409) return null;
      if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${owner}/${repo}`);
      const parsed = CommitsSchema.safeParse(await res.json());
      return parsed.success ? (parsed.data[0]?.sha ?? null) : null;
    });
  }

  fileExists(owner: string, repo: string, sha: string, filePath: string): Promise<boolean> {
    if (
      !isSafeGitHubOwner(owner) ||
      !isSafeGitHubRepo(repo) ||
      !isCommitSha(sha) ||
      !isSafeRepoPath(filePath)
    )
      return Promise.resolve(false);
    return this.memo(`f:${owner}/${repo}@${sha}:${filePath}`, async () => {
      // The contents API lives on api.github.com, the same host used for commit lookups.
      const url = new URL(
        `https://${API_HOST}/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
      );
      url.searchParams.set('ref', sha);
      const res = await this.get(url, { headers: { accept: 'application/vnd.github+json' } });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${filePath}`);
      const body: unknown = await res.json();
      // A directory answers with an array; only a regular file counts.
      return ContentSchema.safeParse(body).success;
    });
  }
}
