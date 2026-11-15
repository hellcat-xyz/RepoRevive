import { z } from 'zod';
import { PublishError, type PublishErrorCode, type TreeEntry } from './changes';
import type { CommitInfo, GitHubApi, PullRequestInfo, RepoInfo, Viewer } from './github-port';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]{1,200}$/;

const Repo = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  default_branch: z.string(),
  private: z.boolean(),
  archived: z.boolean().optional().default(false),
  disabled: z.boolean().optional().default(false),
  fork: z.boolean().optional().default(false),
  parent: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }).nullish(),
  permissions: z
    .object({ push: z.boolean().optional(), pull: z.boolean().optional(), admin: z.boolean().optional() })
    .optional(),
});
const Pull = z.object({
  number: z.number(),
  html_url: z.string().url(),
  draft: z.boolean().optional().default(false),
  state: z.enum(['open', 'closed']),
  head: z.object({ sha: z.string() }),
});

export interface GitHubRestOptions {
  /** Called per request so refreshed tokens are picked up. The token is never logged or put in errors. */
  getToken: () => string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function assertRepo(owner: string, name: string) {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name) || name === '.' || name === '..')
    throw new PublishError('VALIDATION', 'Invalid repository name.');
}
function assertSha(sha: string) {
  if (!SHA_RE.test(sha)) throw new PublishError('VALIDATION', 'Invalid object id.');
}
function assertBranch(b: string) {
  if (!BRANCH_RE.test(b) || b.includes('..') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.lock'))
    throw new PublishError('VALIDATION', 'Invalid branch name.');
}

/** GitHub REST implementation of `GitHubApi` (Git Data API for commits; no git binary, no repository code). */
export class GitHubRest implements GitHubApi {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: GitHubRestOptions) {
    this.base = (o.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.f = o.fetchImpl ?? fetch;
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 202],
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.o.getToken()}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'RepoRevive',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new PublishError('NETWORK', 'Could not reach GitHub (network error or timeout).', true);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (okStatuses.includes(res.status)) return { status: res.status, json };
    throw mapError(res, json);
  }

  async viewer(): Promise<Viewer> {
    const { json } = await this.req('GET', '/user');
    const p = z.object({ id: z.number(), login: z.string() }).safeParse(json);
    if (!p.success) throw new PublishError('SERVER', 'Unexpected response from GitHub.', true);
    return p.data;
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo | null> {
    assertRepo(owner, name);
    try {
      const { json } = await this.req('GET', `/repos/${owner}/${name}`);
      const r = Repo.parse(json);
      return {
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        isPrivate: r.private,
        archived: r.archived,
        disabled: r.disabled,
        fork: r.fork,
        parent: r.parent ? { owner: r.parent.owner.login, name: r.parent.name } : null,
        permissions: {
          push: !!r.permissions?.push,
          pull: !!r.permissions?.pull,
          admin: !!r.permissions?.admin,
        },
      };
    } catch (err) {
      if (err instanceof PublishError && err.code === 'NOT_FOUND') return null;
      if (err instanceof z.ZodError)
        throw new PublishError('SERVER', 'Unexpected response from GitHub.', true);
      throw err;
    }
  }

  async getBranchSha(owner: string, name: string, branch: string): Promise<string | null> {
    assertRepo(owner, name);
    assertBranch(branch);
    try {
      const { json } = await this.req('GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`);
      const p = z.object({ object: z.object({ sha: z.string() }) }).safeParse(json);
      return p.success ? p.data.object.sha : null;
    } catch (err) {
      if (err instanceof PublishError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async createFork(owner: string, name: string) {
    assertRepo(owner, name);
    const { json } = await this.req(
      'POST',
      `/repos/${owner}/${name}/forks`,
      { default_branch_only: true },
      [202],
    );
    const r = Repo.safeParse(json);
    if (!r.success) throw new PublishError('SERVER', 'Unexpected response from GitHub.', true);
    return { owner: r.data.owner.login, name: r.data.name };
  }

  async getCommit(owner: string, name: string, sha: string): Promise<CommitInfo | null> {
    assertRepo(owner, name);
    assertSha(sha);
    try {
      const { json } = await this.req('GET', `/repos/${owner}/${name}/git/commits/${sha}`);
      const p = z
        .object({
          sha: z.string(),
          message: z.string(),
          tree: z.object({ sha: z.string() }),
          parents: z.array(z.object({ sha: z.string() })),
        })
        .parse(json);
      return { sha: p.sha, message: p.message, treeSha: p.tree.sha, parents: p.parents.map((x) => x.sha) };
    } catch (err) {
      if (err instanceof PublishError && err.code === 'NOT_FOUND') return null;
      if (err instanceof z.ZodError)
        throw new PublishError('SERVER', 'Unexpected response from GitHub.', true);
      throw err;
    }
  }

  async getTreeModes(
    owner: string,
    name: string,
    treeSha: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    assertRepo(owner, name);
    assertSha(treeSha);
    const out = new Map<string, string>();
    const cache = new Map<string, Map<string, { mode: string; sha: string }>>();
    const dir = async (sha: string) => {
      let m = cache.get(sha);
      if (!m) {
        const { json } = await this.req('GET', `/repos/${owner}/${name}/git/trees/${sha}`);
        const p = z
          .object({ tree: z.array(z.object({ path: z.string(), mode: z.string(), sha: z.string() })) })
          .parse(json);
        m = new Map(p.tree.map((e) => [e.path, { mode: e.mode, sha: e.sha }]));
        cache.set(sha, m);
      }
      return m;
    };
    for (const path of paths) {
      let sha = treeSha;
      const segs = path.split('/');
      for (let i = 0; i < segs.length; i++) {
        const entry = (await dir(sha)).get(segs[i]!);
        if (!entry) break;
        if (i === segs.length - 1) out.set(path, entry.mode);
        else if (entry.mode === '040000') sha = entry.sha;
        else break;
      }
    }
    return out;
  }

  async createTree(owner: string, name: string, baseTree: string, entries: TreeEntry[]): Promise<string> {
    assertRepo(owner, name);
    assertSha(baseTree);
    const tree = entries.map((e) =>
      e.sha === null
        ? { path: e.path, mode: e.mode, type: 'blob', sha: null }
        : { path: e.path, mode: e.mode, type: 'blob', content: e.content ?? '' },
    );
    const { json } = await this.req('POST', `/repos/${owner}/${name}/git/trees`, {
      base_tree: baseTree,
      tree,
    });
    return z.object({ sha: z.string() }).parse(json).sha;
  }

  async createCommit(
    owner: string,
    name: string,
    input: { message: string; tree: string; parents: string[] },
  ): Promise<string> {
    assertRepo(owner, name);
    assertSha(input.tree);
    input.parents.forEach(assertSha);
    const { json } = await this.req('POST', `/repos/${owner}/${name}/git/commits`, input);
    return z.object({ sha: z.string() }).parse(json).sha;
  }

  async createBranch(owner: string, name: string, branch: string, sha: string): Promise<void> {
    assertRepo(owner, name);
    assertBranch(branch);
    assertSha(sha);
    await this.req('POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha }, [201]);
  }

  async findPullRequest(owner: string, name: string, head: string): Promise<PullRequestInfo | null> {
    assertRepo(owner, name);
    if (!/^[A-Za-z0-9-]{1,39}:[A-Za-z0-9._\-/]{1,200}$/.test(head))
      throw new PublishError('VALIDATION', 'Invalid head ref.');
    const { json } = await this.req(
      'GET',
      `/repos/${owner}/${name}/pulls?state=open&per_page=5&head=${encodeURIComponent(head)}`,
    );
    const list = z.array(Pull).parse(json);
    const p = list[0];
    return p
      ? { number: p.number, url: p.html_url, draft: p.draft, state: p.state, headSha: p.head.sha }
      : null;
  }

  async createDraftPullRequest(i: {
    owner: string;
    name: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequestInfo> {
    assertRepo(i.owner, i.name);
    assertBranch(i.base);
    const { json } = await this.req('POST', `/repos/${i.owner}/${i.name}/pulls`, {
      title: i.title,
      body: i.body,
      head: i.head,
      base: i.base,
      draft: true,
      maintainer_can_modify: true,
    });
    const p = Pull.parse(json);
    return { number: p.number, url: p.html_url, draft: p.draft, state: p.state, headSha: p.head.sha };
  }
}

function mapError(res: Response, json: unknown): PublishError {
  const message =
    typeof (json as { message?: unknown } | null)?.message === 'string'
      ? (json as { message: string }).message
      : '';
  const s = res.status;
  const retryAfterHeader = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const waitMs =
    Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : Number.isFinite(reset) && reset > 0
        ? Math.max(0, reset * 1000 - Date.now())
        : undefined;
  const mk = (code: PublishErrorCode, text: string, retryable = false) =>
    new PublishError(
      code,
      `${text}${message ? ` (${message.slice(0, 160)})` : ''}`,
      retryable,
      retryable ? waitMs : undefined,
    );
  if (s === 401) return mk('AUTH_EXPIRED', 'GitHub rejected the credentials');
  if (s === 429 || (s === 403 && (remaining === '0' || /rate limit|abuse|secondary/i.test(message))))
    return mk('RATE_LIMITED', 'GitHub rate limit reached', true);
  if (s === 403) return mk('FORBIDDEN', 'GitHub denied this operation');
  if (s === 404) return mk('NOT_FOUND', 'Not found or not accessible');
  if (s === 409 || (s === 422 && /already exists/i.test(message))) return mk('CONFLICT', 'Conflict');
  if (s === 422) return mk('VALIDATION', 'GitHub rejected the request');
  if (s >= 500) return mk('SERVER', `GitHub server error ${s}`, true);
  return mk('SERVER', `Unexpected GitHub response ${s}`, true);
}
