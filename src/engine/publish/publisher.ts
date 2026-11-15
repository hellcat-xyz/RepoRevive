import { partitionChanges, PublishError, type PublishChange, toTreeEntries } from './changes';
import type { GitHubApi, RepoInfo } from './github-port';
import {
  assertTransition,
  canTransition,
  isActive,
  MAX_PUBLISH_ATTEMPTS,
  type PublicationStatus,
} from './state';

export interface PublicationRecord {
  id: string;
  resurrectionId: string;
  idempotencyKey: string;
  status: PublicationStatus;
  targetOwner: string;
  targetRepo: string;
  baseBranch: string;
  baseSha: string;
  headOwner: string | null;
  headRepo: string | null;
  headBranch: string;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  title: string;
  body: string;
  changes: PublishChange[];
  allowFork: boolean;
  attempts: number;
}

export type PublicationPatch = Partial<
  Pick<
    PublicationRecord,
    | 'status'
    | 'headOwner'
    | 'headRepo'
    | 'headBranch'
    | 'commitSha'
    | 'prNumber'
    | 'prUrl'
    | 'attempts'
    | 'baseSha'
  >
> & { lastError?: string | null; lastErrorCode?: string | null; completedAt?: Date | null };

/** Persistence port. `claim` must be atomic so two workers never run the same publication. */
export interface PublicationStore {
  load(id: string): Promise<PublicationRecord | null>;
  update(id: string, patch: PublicationPatch): Promise<void>;
  claim(id: string, workerId: string): Promise<boolean>;
  release(id: string, workerId: string): Promise<void>;
  /** Another publication (different job) already targets this repository at the same base and is not failed/cancelled. */
  hasConflictingActive(rec: PublicationRecord): Promise<boolean>;
}

export interface PublishEvent {
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  data?: Record<string, unknown>;
}

export interface PublisherDeps {
  store: PublicationStore;
  api: GitHubApi;
  /** GitHub login of the connected user; the token must belong to this account. */
  expectedLogin: string;
  workerId: string;
  emit: (e: PublishEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  forkPollAttempts?: number;
  maxApiAttempts?: number;
}

export type PublishOutcome =
  | { status: 'CREATED'; prNumber: number; prUrl: string; reused: boolean }
  | {
      status: 'FAILED' | 'BLOCKED' | 'AUTH_EXPIRED' | 'CANCELLED' | 'BUSY' | 'NOT_RUNNABLE';
      error?: string;
      code?: string;
    };

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRYABLE = new Set(['RATE_LIMITED', 'NETWORK', 'SERVER']);
const MARKER = 'RepoRevive-Publication:';

export function commitMessage(
  rec: Pick<PublicationRecord, 'title' | 'resurrectionId' | 'idempotencyKey'>,
): string {
  return `${rec.title}\n\nGenerated automatically by RepoRevive (job ${rec.resurrectionId}).\n\n${MARKER} ${rec.idempotencyKey}\n`;
}

export function branchCandidates(base: string): string[] {
  return [base, ...[2, 3, 4, 5].map((n) => `${base}-${n}`)];
}

class Run {
  rec: PublicationRecord;
  constructor(
    private readonly d: PublisherDeps,
    rec: PublicationRecord,
  ) {
    this.rec = rec;
  }

  private sleep = (ms: number) => (this.d.sleep ?? sleepReal)(ms);
  log = (level: PublishEvent['level'], message: string, data?: Record<string, unknown>) =>
    this.d.emit({ level, message, data });

  /** Bounded retry for transient GitHub failures. Non-retryable errors surface immediately. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.d.maxApiAttempts ?? 3;
    for (let n = 1; ; n++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof PublishError) || !RETRYABLE.has(err.code) || n >= max) throw err;
        const wait = Math.min(err.retryAfterMs ?? 500 * 2 ** (n - 1), 30_000);
        this.log(
          'warn',
          `GitHub ${err.code.toLowerCase()}; retrying in ${Math.round(wait / 1000)}s (${n}/${max - 1}).`,
        );
        await this.sleep(wait);
      }
    }
  }

  async advance(to: PublicationStatus, patch: PublicationPatch = {}) {
    const from = this.rec.status;
    if (from !== to && !canTransition(from, to) && !(isActive(from) && isActive(to)))
      assertTransition(from, to);
    await this.d.store.update(this.rec.id, { ...patch, status: to });
    this.rec = { ...this.rec, ...patch, status: to } as PublicationRecord;
  }

  async persist(patch: PublicationPatch) {
    await this.d.store.update(this.rec.id, patch);
    this.rec = { ...this.rec, ...patch } as PublicationRecord;
  }

  /** Resolve where the branch will live: the target itself (push access) or the user's fork. */
  async resolveHead(target: RepoInfo): Promise<{ owner: string; name: string; viaFork: boolean }> {
    if (target.permissions.push) return { owner: target.owner, name: target.name, viaFork: false };
    if (!target.permissions.pull)
      throw new PublishError('FORBIDDEN', 'The connected account cannot read this repository.');
    const login = this.d.expectedLogin;
    let fork = await this.call(() => this.d.api.getRepo(login, target.name));
    const isForkOfTarget = (f: RepoInfo | null) =>
      !!f &&
      f.fork &&
      f.parent?.owner.toLowerCase() === target.owner.toLowerCase() &&
      f.parent.name === target.name;
    if (fork && !isForkOfTarget(fork))
      throw new PublishError(
        'CONFLICT',
        `${login}/${target.name} exists and is not a fork of ${target.owner}/${target.name}.`,
      );
    if (!fork) {
      if (!this.rec.allowFork)
        throw new PublishError(
          'FORBIDDEN',
          'You do not have write access to this repository. Allow RepoRevive to create a fork to open a pull request from it.',
        );
      this.log('info', `Creating a fork of ${target.owner}/${target.name} for ${login}.`);
      const created = await this.call(() => this.d.api.createFork(target.owner, target.name));
      fork = await this.waitForFork(created.owner, created.name, target.defaultBranch);
    }
    return { owner: fork.owner, name: fork.name, viaFork: true };
  }

  private async waitForFork(owner: string, name: string, branch: string): Promise<RepoInfo> {
    const attempts = this.d.forkPollAttempts ?? 8;
    for (let n = 1; n <= attempts; n++) {
      const repo = await this.call(() => this.d.api.getRepo(owner, name));
      if (repo && (await this.call(() => this.d.api.getBranchSha(owner, name, branch)))) return repo;
      this.log('info', `Waiting for the fork to become available (${n}/${attempts}).`);
      await this.sleep(Math.min(2000 * n, 15_000));
    }
    throw new PublishError('NETWORK', 'The fork is not ready yet. Retry in a minute.', true);
  }

  /** Reuse a branch that this publication created earlier (crash recovery); never adopt someone else's. */
  async pickBranch(head: { owner: string; name: string }): Promise<{ branch: string; sha: string | null }> {
    for (const candidate of branchCandidates(this.rec.headBranch.replace(/-[2-5]$/, ''))) {
      const sha = await this.call(() => this.d.api.getBranchSha(head.owner, head.name, candidate));
      if (sha === null) return { branch: candidate, sha: null };
      if (this.rec.commitSha && sha === this.rec.commitSha) return { branch: candidate, sha };
      const commit = await this.call(() => this.d.api.getCommit(head.owner, head.name, sha));
      if (
        commit?.message.includes(`${MARKER} ${this.rec.idempotencyKey}`) &&
        commit.parents[0] === this.rec.baseSha
      )
        return { branch: candidate, sha };
    }
    throw new PublishError('CONFLICT', 'All candidate branch names are already used by other work.');
  }
}

/**
 * Publish one accepted patch as a draft pull request. Safe to call repeatedly: it reconciles remote
 * state (branch, commit, PR) before creating anything, and never merges, approves or force-pushes.
 */
export async function runPublication(deps: PublisherDeps, id: string): Promise<PublishOutcome> {
  const { store } = deps;
  const initial = await store.load(id);
  if (!initial) return { status: 'NOT_RUNNABLE', error: 'Publication not found.' };
  if (initial.status === 'CREATED' && initial.prNumber && initial.prUrl)
    return { status: 'CREATED', prNumber: initial.prNumber, prUrl: initial.prUrl, reused: true };
  const runnable: PublicationStatus[] = [
    'QUEUED',
    'AUTHORIZING',
    'PREPARING_BRANCH',
    'PUBLISHING_COMMIT',
    'CREATING_PR',
  ];
  if (!runnable.includes(initial.status))
    return { status: 'NOT_RUNNABLE', error: `Publication is ${initial.status}.` };
  if (!(await store.claim(id, deps.workerId))) return { status: 'BUSY' };

  const run = new Run(deps, initial);
  try {
    await run.persist({ attempts: initial.attempts + 1 });
    await run.advance('AUTHORIZING');
    const rec = run.rec;

    const viewer = await run.call(() => deps.api.viewer());
    if (viewer.login.toLowerCase() !== deps.expectedLogin.toLowerCase())
      throw new PublishError(
        'FORBIDDEN',
        'The GitHub token belongs to a different account than the one connected.',
      );

    const { publishable } = partitionChanges(rec.changes);
    if (publishable.length === 0) throw new PublishError('EMPTY_PATCH', 'There are no publishable changes.');

    const target = await run.call(() => deps.api.getRepo(rec.targetOwner, rec.targetRepo));
    if (!target)
      throw new PublishError(
        'NOT_FOUND',
        'The repository was not found or is not accessible to this account.',
      );
    if (target.archived || target.disabled)
      throw new PublishError('FORBIDDEN', 'The repository is archived or disabled.');

    // Existing PR from a previous (crashed) run wins; this keeps retries idempotent.
    if (rec.prNumber && rec.prUrl) {
      await run.advance('CREATED', { completedAt: new Date() });
      return { status: 'CREATED', prNumber: rec.prNumber, prUrl: rec.prUrl, reused: true };
    }

    if (await store.hasConflictingActive(rec))
      throw new PublishError(
        'CONFLICT',
        'Another RepoRevive publication already targets this repository at the same commit.',
      );

    const baseNow = await run.call(() =>
      deps.api.getBranchSha(rec.targetOwner, rec.targetRepo, rec.baseBranch),
    );
    if (baseNow === null)
      throw new PublishError('NOT_FOUND', `Base branch ${rec.baseBranch} no longer exists.`);
    if (baseNow !== rec.baseSha)
      throw new PublishError(
        'DRIFT',
        `The base branch moved from ${rec.baseSha.slice(0, 8)} to ${baseNow.slice(0, 8)} after verification. Run RepoRevive again on the new commit.`,
      );

    const head = await run.resolveHead(target);
    await run.advance('PREPARING_BRANCH', { headOwner: head.owner, headRepo: head.name });
    const picked = await run.pickBranch(head);
    let commitSha = picked.sha;
    if (picked.branch !== rec.headBranch) await run.persist({ headBranch: picked.branch });

    if (commitSha === null) {
      await run.advance('PUBLISHING_COMMIT');
      const baseCommit = await run.call(() =>
        deps.api.getCommit(rec.targetOwner, rec.targetRepo, rec.baseSha),
      );
      if (!baseCommit) throw new PublishError('NOT_FOUND', 'The base commit could not be read.');
      const needExisting = publishable.filter((c) => c.before !== null).map((c) => c.path);
      const modes = await run.call(() =>
        deps.api.getTreeModes(rec.targetOwner, rec.targetRepo, baseCommit.treeSha, needExisting),
      );
      const entries = toTreeEntries(publishable, modes);
      const tree = await run.call(() =>
        deps.api.createTree(head.owner, head.name, baseCommit.treeSha, entries),
      );
      commitSha = await run.call(() =>
        deps.api.createCommit(head.owner, head.name, {
          message: commitMessage(rec),
          tree,
          parents: [rec.baseSha],
        }),
      );
      await run.persist({ commitSha });
      try {
        await run.call(() => deps.api.createBranch(head.owner, head.name, run.rec.headBranch, commitSha!));
      } catch (err) {
        if (!(err instanceof PublishError) || err.code !== 'CONFLICT') throw err;
        // Lost a race with a concurrent attempt: adopt only if the branch is ours.
        const again = await run.pickBranch(head);
        if (again.sha === null) throw err;
        commitSha = again.sha;
        await run.persist({ commitSha, headBranch: again.branch });
      }
      run.log(
        'success',
        `Published commit ${commitSha.slice(0, 8)} to ${head.owner}/${head.name}:${run.rec.headBranch}.`,
      );
    } else {
      await run.persist({ commitSha });
      run.log('info', `Reusing existing branch ${run.rec.headBranch} at ${commitSha.slice(0, 8)}.`);
    }

    await run.advance('CREATING_PR');
    const headRef = `${head.owner}:${run.rec.headBranch}`;
    let pr = await run.call(() => deps.api.findPullRequest(rec.targetOwner, rec.targetRepo, headRef));
    let reused = true;
    if (!pr) {
      reused = false;
      try {
        pr = await run.call(() =>
          deps.api.createDraftPullRequest({
            owner: rec.targetOwner,
            name: rec.targetRepo,
            title: rec.title,
            body: rec.body,
            head: headRef,
            base: rec.baseBranch,
          }),
        );
      } catch (err) {
        if (!(err instanceof PublishError) || err.code !== 'VALIDATION') throw err;
        pr = await run.call(() => deps.api.findPullRequest(rec.targetOwner, rec.targetRepo, headRef));
        if (!pr) throw err;
        reused = true;
      }
    }
    await run.advance('CREATED', {
      prNumber: pr.number,
      prUrl: pr.url,
      completedAt: new Date(),
      lastError: null,
      lastErrorCode: null,
    });
    run.log('success', `${reused ? 'Found existing' : 'Opened draft'} pull request #${pr.number}.`, {
      url: pr.url,
    });
    return { status: 'CREATED', prNumber: pr.number, prUrl: pr.url, reused };
  } catch (err) {
    return await fail(run, err, deps);
  } finally {
    await store.release(id, deps.workerId).catch(() => undefined);
  }
}

async function fail(run: Run, err: unknown, deps: PublisherDeps): Promise<PublishOutcome> {
  const pe =
    err instanceof PublishError
      ? err
      : new PublishError('SERVER', err instanceof Error ? err.message : String(err), true);
  const status: PublicationStatus =
    pe.code === 'AUTH_EXPIRED'
      ? 'AUTH_EXPIRED'
      : RETRYABLE.has(pe.code) || pe.retryable
        ? 'FAILED'
        : 'BLOCKED';
  const exhausted = run.rec.attempts >= MAX_PUBLISH_ATTEMPTS && status === 'FAILED';
  const message = pe.message.slice(0, 500);
  try {
    await run.advance(status, {
      lastError: exhausted ? `${message} (retry limit reached)` : message,
      lastErrorCode: pe.code,
    });
  } catch {
    await deps.store
      .update(run.rec.id, { status, lastError: message, lastErrorCode: pe.code })
      .catch(() => undefined);
  }
  run.log('error', `Publication ${status.toLowerCase()}: ${message}`, { code: pe.code });
  return { status, error: message, code: pe.code };
}
