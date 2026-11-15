import { createHash } from 'node:crypto';
import { PublishError, type PublishChange, type TreeEntry } from '@/engine/publish/changes';
import type { CommitInfo, GitHubApi, PullRequestInfo, RepoInfo, Viewer } from '@/engine/publish/github-port';
import type { PublicationPatch, PublicationRecord, PublicationStore } from '@/engine/publish/publisher';

interface FakeRepo {
  info: RepoInfo;
  branches: Map<string, string>;
  /** Number of getRepo/getBranchSha polls before a freshly created fork becomes visible. */
  hiddenPolls: number;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

/** In-memory GitHub with a shared object store (like a fork network) and scripted failures. */
export class FakeGitHub implements GitHubApi {
  readonly repos = new Map<string, FakeRepo>();
  readonly commits = new Map<string, CommitInfo>();
  readonly trees = new Map<string, Map<string, { mode: string; content: string | null }>>();
  readonly prs: (PullRequestInfo & {
    owner: string;
    name: string;
    head: string;
    base: string;
    title: string;
  })[] = [];
  readonly calls: string[] = [];
  readonly treeEntries: TreeEntry[][] = [];
  private failures = new Map<string, PublishError[]>();

  constructor(public viewerInfo: Viewer = { id: 1, login: 'me' }) {}

  /** Queue errors thrown by the next calls of `method`. */
  failNext(method: string, ...errors: PublishError[]) {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...errors]);
  }

  addRepo(
    owner: string,
    name: string,
    opts: {
      push?: boolean;
      files?: Record<string, string>;
      modes?: Record<string, string>;
      fork?: { owner: string; name: string };
    } = {},
  ): string {
    const files = new Map(
      Object.entries(opts.files ?? { 'README.md': 'hello\n' }).map(([p, c]) => [
        p,
        { mode: opts.modes?.[p] ?? '100644', content: c as string | null },
      ]),
    );
    const treeSha = sha(`tree:${owner}/${name}:${[...files.keys()].join(',')}`);
    this.trees.set(treeSha, files);
    const commitSha = sha(`commit:${owner}/${name}`);
    this.commits.set(commitSha, { sha: commitSha, treeSha, parents: [], message: 'base' });
    this.repos.set(`${owner}/${name}`, {
      info: {
        owner,
        name,
        defaultBranch: 'main',
        isPrivate: false,
        archived: false,
        disabled: false,
        fork: Boolean(opts.fork),
        parent: opts.fork ?? null,
        permissions: { push: opts.push ?? false, pull: true, admin: false },
      },
      branches: new Map([['main', commitSha]]),
      hiddenPolls: 0,
    });
    return commitSha;
  }

  private hit(method: string) {
    this.calls.push(method);
    const q = this.failures.get(method);
    const e = q?.shift();
    if (e) throw e;
  }
  count(method: string) {
    return this.calls.filter((c) => c === method).length;
  }

  async viewer() {
    this.hit('viewer');
    return this.viewerInfo;
  }
  async getRepo(owner: string, name: string) {
    this.hit('getRepo');
    const r = this.repos.get(`${owner}/${name}`);
    if (!r) return null;
    if (r.hiddenPolls > 0) {
      r.hiddenPolls--;
      return null;
    }
    return r.info;
  }
  async getBranchSha(owner: string, name: string, branch: string) {
    this.hit('getBranchSha');
    const r = this.repos.get(`${owner}/${name}`);
    if (!r || r.hiddenPolls > 0) return null;
    return r.branches.get(branch) ?? null;
  }
  async createFork(owner: string, name: string) {
    this.hit('createFork');
    const src = this.repos.get(`${owner}/${name}`)!;
    const login = this.viewerInfo.login;
    this.repos.set(`${login}/${name}`, {
      info: {
        ...src.info,
        owner: login,
        name,
        fork: true,
        parent: { owner, name },
        permissions: { push: true, pull: true, admin: true },
      },
      branches: new Map(src.branches),
      hiddenPolls: 2,
    });
    return { owner: login, name };
  }
  async getCommit(_o: string, _n: string, s: string) {
    this.hit('getCommit');
    return this.commits.get(s) ?? null;
  }
  async getTreeModes(_o: string, _n: string, treeSha: string, paths: string[]) {
    this.hit('getTreeModes');
    const t = this.trees.get(treeSha) ?? new Map();
    return new Map(paths.filter((p) => t.has(p)).map((p) => [p, t.get(p)!.mode] as [string, string]));
  }
  async createTree(_o: string, _n: string, baseTree: string, entries: TreeEntry[]) {
    this.hit('createTree');
    this.treeEntries.push(entries);
    const next = new Map(this.trees.get(baseTree) ?? []);
    for (const e of entries) {
      if (e.sha === null) next.delete(e.path);
      else next.set(e.path, { mode: e.mode, content: e.content ?? '' });
    }
    const id = sha(JSON.stringify([...next.entries()]));
    this.trees.set(id, next);
    return id;
  }
  async createCommit(_o: string, _n: string, input: { message: string; tree: string; parents: string[] }) {
    this.hit('createCommit');
    const id = sha(`${input.tree}${input.parents.join()}${input.message}`);
    this.commits.set(id, { sha: id, treeSha: input.tree, parents: input.parents, message: input.message });
    return id;
  }
  async createBranch(owner: string, name: string, branch: string, s: string) {
    this.hit('createBranch');
    const r = this.repos.get(`${owner}/${name}`)!;
    if (r.branches.has(branch)) throw new PublishError('CONFLICT', 'Reference already exists');
    r.branches.set(branch, s);
  }
  async findPullRequest(owner: string, name: string, head: string) {
    this.hit('findPullRequest');
    return (
      this.prs.find((p) => p.owner === owner && p.name === name && p.head === head && p.state === 'open') ??
      null
    );
  }
  async createDraftPullRequest(i: {
    owner: string;
    name: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }) {
    this.hit('createDraftPullRequest');
    const pr = {
      number: this.prs.length + 1,
      url: `https://github.com/${i.owner}/${i.name}/pull/${this.prs.length + 1}`,
      draft: true,
      state: 'open' as const,
      headSha: 'x',
      owner: i.owner,
      name: i.name,
      head: i.head,
      base: i.base,
      title: i.title,
    };
    this.prs.push(pr);
    return pr;
  }
}

export class MemoryPublicationStore implements PublicationStore {
  readonly records = new Map<
    string,
    PublicationRecord & { lastError?: string | null; lastErrorCode?: string | null }
  >();
  readonly lock = new Map<string, string>();
  failOnStatus: string | null = null;
  others: PublicationRecord[] = [];

  async load(id: string) {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }
  async update(id: string, patch: PublicationPatch) {
    if (this.failOnStatus && patch.status === this.failOnStatus) {
      this.failOnStatus = null;
      throw new Error('database write failed (simulated crash)');
    }
    const r = this.records.get(id)!;
    Object.assign(r, patch);
  }
  async claim(id: string, workerId: string) {
    if (this.lock.has(id)) return false;
    this.lock.set(id, workerId);
    return true;
  }
  async release(id: string, workerId: string) {
    if (this.lock.get(id) === workerId) this.lock.delete(id);
  }
  async hasConflictingActive(rec: PublicationRecord) {
    return this.others.some(
      (o) =>
        o.targetOwner === rec.targetOwner &&
        o.targetRepo === rec.targetRepo &&
        o.baseSha === rec.baseSha &&
        o.resurrectionId !== rec.resurrectionId,
    );
  }
}

export function makeRecord(
  over: Partial<PublicationRecord> & { changes?: PublishChange[] } = {},
): PublicationRecord {
  return {
    id: 'pub1',
    resurrectionId: 'job12345abcdef',
    idempotencyKey: 'key-job12345abcdef',
    status: 'QUEUED',
    targetOwner: 'acme',
    targetRepo: 'widget',
    baseBranch: 'main',
    baseSha: '',
    headOwner: null,
    headRepo: null,
    headBranch: 'reporevive/fix-job12345',
    commitSha: null,
    prNumber: null,
    prUrl: null,
    title: 'fix(revive): restore compatibility and build verification',
    body: 'body',
    changes: [{ path: 'README.md', before: 'hello\n', after: 'hello world\n' }],
    allowFork: false,
    attempts: 0,
    ...over,
  };
}
