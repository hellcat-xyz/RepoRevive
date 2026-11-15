import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describeEntries,
  partitionChanges,
  PublishError,
  toTreeEntries,
  type PublishChange,
} from '@/engine/publish/changes';
import { evaluatePublishPolicy, type PublishPolicyInput } from '@/engine/publish/policy';
import { runPublication, type PublisherDeps } from '@/engine/publish/publisher';
import {
  canTransition,
  isTerminal,
  PUBLICATION_STATUSES,
  TRANSITIONS,
  type PublicationStatus,
} from '@/engine/publish/state';
import { FakeGitHub, makeRecord, MemoryPublicationStore } from '../helpers/fake-github';

function setup(
  opts: {
    push?: boolean;
    allowFork?: boolean;
    changes?: PublishChange[];
    files?: Record<string, string>;
    modes?: Record<string, string>;
  } = {},
) {
  const gh = new FakeGitHub();
  const baseSha = gh.addRepo('acme', 'widget', {
    push: opts.push ?? true,
    files: opts.files,
    modes: opts.modes,
  });
  const store = new MemoryPublicationStore();
  const rec = makeRecord({
    baseSha,
    allowFork: opts.allowFork ?? false,
    ...(opts.changes ? { changes: opts.changes } : {}),
  });
  store.records.set(rec.id, rec);
  const events: string[] = [];
  const sleeps: number[] = [];
  const deps: PublisherDeps = {
    store,
    api: gh,
    expectedLogin: 'me',
    workerId: 'w1',
    emit: (e) => events.push(e.message),
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { gh, store, rec, deps, events, sleeps, baseSha };
}
const WRITES = ['createTree', 'createCommit', 'createBranch', 'createDraftPullRequest', 'createFork'];
const writes = (gh: FakeGitHub) => gh.calls.filter((c) => WRITES.includes(c));

describe('direct-branch publication', () => {
  it('commits exactly the accepted changes to a new branch and opens a draft PR', async () => {
    const s = setup({
      files: { 'README.md': 'hello\n', 'old.txt': 'x', 'run.sh': '#!/bin/sh\n' },
      modes: { 'run.sh': '100755' },
      changes: [
        { path: 'README.md', before: 'hello\n', after: 'hello world\n' },
        { path: 'old.txt', before: 'x', after: null },
        { path: 'new.txt', before: null, after: 'new\n' },
        { path: 'run.sh', before: '#!/bin/sh\n', after: '#!/bin/sh\necho hi\n' },
        { path: '.github/workflows/ci.yml', before: 'a', after: 'b' },
      ],
    });
    const out = await runPublication(s.deps, 'pub1');
    expect(out).toMatchObject({ status: 'CREATED', prNumber: 1, reused: false });
    expect(s.store.records.get('pub1')).toMatchObject({ status: 'CREATED', prNumber: 1, headOwner: 'acme' });
    // Published == accepted (minus the excluded workflow file).
    expect(describeEntries(s.gh.treeEntries[0]!)).toEqual({
      'README.md': 'hello world\n',
      'old.txt': null,
      'new.txt': 'new\n',
      'run.sh': '#!/bin/sh\necho hi\n',
    });
    expect(s.gh.treeEntries[0]!.find((e) => e.path === 'run.sh')?.mode).toBe('100755');
    // Base branch untouched; head is a new branch; PR is a draft.
    expect(s.gh.repos.get('acme/widget')!.branches.get('main')).toBe(s.baseSha);
    expect(s.gh.repos.get('acme/widget')!.branches.has('reporevive/fix-job12345')).toBe(true);
    expect(s.gh.prs[0]).toMatchObject({ draft: true, base: 'main', head: 'acme:reporevive/fix-job12345' });
    const commit = [...s.gh.commits.values()].find((c) => c.message.includes('RepoRevive-Publication'))!;
    expect(commit.parents).toEqual([s.baseSha]);
  });

  it('rejects an empty patch (only excluded/no-op changes) without writing', async () => {
    const s = setup({ changes: [{ path: '.github/workflows/ci.yml', before: 'a', after: 'b' }] });
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'EMPTY_PATCH' });
    expect(writes(s.gh)).toEqual([]);
  });

  it('blocks when the base branch moved (drift) and writes nothing', async () => {
    const s = setup();
    s.gh.repos.get('acme/widget')!.branches.set('main', 'f'.repeat(40));
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'DRIFT' });
    expect(writes(s.gh)).toEqual([]);
  });

  it('blocks symlinks and submodules instead of converting them', async () => {
    const s = setup({ modes: { 'README.md': '120000' } });
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({
      status: 'BLOCKED',
      code: 'UNSUPPORTED_CHANGE',
    });
    expect(s.gh.count('createBranch')).toBe(0);
  });

  it('blocks when another publication targets the same base', async () => {
    const s = setup();
    s.store.others.push({ ...s.rec, id: 'other', resurrectionId: 'other-job' });
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'CONFLICT' });
    expect(writes(s.gh)).toEqual([]);
  });

  it('blocks archived repositories and a token for the wrong account', async () => {
    const a = setup();
    a.gh.repos.get('acme/widget')!.info.archived = true;
    expect(await runPublication(a.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'FORBIDDEN' });
    const b = setup();
    b.gh.viewerInfo = { id: 2, login: 'mallory' };
    expect(await runPublication(b.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'FORBIDDEN' });
    expect(writes(b.gh)).toEqual([]);
  });

  it('uses a different branch when the name is taken by unrelated work', async () => {
    const s = setup();
    s.gh.repos.get('acme/widget')!.branches.set('reporevive/fix-job12345', 'e'.repeat(40));
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'CREATED' });
    expect(s.store.records.get('pub1')!.headBranch).toBe('reporevive/fix-job12345-2');
    expect(s.gh.repos.get('acme/widget')!.branches.get('reporevive/fix-job12345')).toBe('e'.repeat(40));
  });
});

describe('fork publication', () => {
  it('forks (when allowed), waits for the fork, and opens a cross-repository draft PR', async () => {
    const s = setup({ push: false, allowFork: true });
    const out = await runPublication(s.deps, 'pub1');
    expect(out).toMatchObject({ status: 'CREATED' });
    expect(s.gh.count('createFork')).toBe(1);
    expect(s.sleeps.length).toBeGreaterThan(0); // delayed fork availability
    expect(s.gh.prs[0]).toMatchObject({
      owner: 'acme',
      name: 'widget',
      head: 'me:reporevive/fix-job12345',
      draft: true,
    });
    expect(s.gh.repos.get('me/widget')!.branches.has('reporevive/fix-job12345')).toBe(true);
    expect(s.gh.repos.get('acme/widget')!.branches.size).toBe(1);
  });

  it('never forks without explicit permission and does not claim success', async () => {
    const s = setup({ push: false, allowFork: false });
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'FORBIDDEN' });
    expect(s.gh.count('createFork')).toBe(0);
    expect(s.gh.prs).toHaveLength(0);
  });

  it('reuses an existing fork', async () => {
    const s = setup({ push: false, allowFork: true });
    s.gh.addRepo('me', 'widget', { push: true, fork: { owner: 'acme', name: 'widget' } });
    s.gh.repos.get('me/widget')!.branches = new Map(s.gh.repos.get('acme/widget')!.branches);
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'CREATED' });
    expect(s.gh.count('createFork')).toBe(0);
  });

  it('refuses a same-named repository that is not a fork of the target', async () => {
    const s = setup({ push: false, allowFork: true });
    s.gh.addRepo('me', 'widget', { push: true });
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'CONFLICT' });
  });
});

describe('idempotency and failure recovery', () => {
  it('rerunning a completed publication returns the same PR and makes no calls', async () => {
    const s = setup();
    const first = await runPublication(s.deps, 'pub1');
    const calls = s.gh.calls.length;
    const second = await runPublication(s.deps, 'pub1');
    expect(second).toMatchObject({ status: 'CREATED', reused: true });
    expect(
      first.status === 'CREATED' && second.status === 'CREATED' && first.prNumber === second.prNumber,
    ).toBe(true);
    expect(s.gh.calls.length).toBe(calls);
    expect(s.gh.prs).toHaveLength(1);
  });

  it('concurrent requests produce one PR (the second sees BUSY)', async () => {
    const s = setup();
    const [a, b] = await Promise.all([
      runPublication(s.deps, 'pub1'),
      runPublication({ ...s.deps, workerId: 'w2' }, 'pub1'),
    ]);
    expect([a.status, b.status].sort()).toEqual(['BUSY', 'CREATED']);
    expect(s.gh.prs).toHaveLength(1);
  });

  it('worker crash after the PR was created remotely: retry adopts it instead of creating another', async () => {
    const s = setup();
    s.store.failOnStatus = 'CREATED'; // the DB write after PR creation fails
    const first = await runPublication(s.deps, 'pub1');
    expect(first.status).not.toBe('CREATED');
    expect(s.gh.prs).toHaveLength(1);
    // Operator/user retry: record is in a retryable state (or stuck active); requeue and run again.
    const rec = s.store.records.get('pub1')!;
    rec.status = 'QUEUED';
    const second = await runPublication(s.deps, 'pub1');
    expect(second).toMatchObject({ status: 'CREATED', reused: true });
    expect(s.gh.prs).toHaveLength(1);
    expect(s.gh.count('createCommit')).toBe(1);
  });

  it('crash after the branch was created but before the commit sha was stored: adopts our branch', async () => {
    const s = setup();
    const out1 = await runPublication(s.deps, 'pub1');
    expect(out1.status).toBe('CREATED');
    // Simulate lost DB state: forget commit/PR but keep the remote branch and PR.
    const rec = s.store.records.get('pub1')!;
    Object.assign(rec, { status: 'QUEUED', commitSha: null, prNumber: null, prUrl: null });
    const out2 = await runPublication(s.deps, 'pub1');
    expect(out2).toMatchObject({ status: 'CREATED', reused: true });
    expect(s.gh.count('createCommit')).toBe(1);
    expect(s.gh.prs).toHaveLength(1);
  });

  it('retries transient rate limits with bounded backoff', async () => {
    const s = setup();
    s.gh.failNext('createTree', new PublishError('RATE_LIMITED', 'slow down', true, 4000));
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'CREATED' });
    expect(s.sleeps).toContain(4000);
  });

  it('persistent network failure ends FAILED (retryable) and a later retry succeeds without duplicates', async () => {
    const s = setup();
    s.gh.failNext(
      'createDraftPullRequest',
      ...Array.from({ length: 3 }, () => new PublishError('NETWORK', 'timeout', true)),
    );
    const out = await runPublication(s.deps, 'pub1');
    expect(out).toMatchObject({ status: 'FAILED', code: 'NETWORK' });
    expect(s.store.records.get('pub1')!.lastError).toMatch(/timeout/);
    s.store.records.get('pub1')!.status = 'QUEUED';
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'CREATED' });
    expect(s.gh.prs).toHaveLength(1);
    expect(s.gh.count('createBranch')).toBe(1);
    expect(s.gh.count('createCommit')).toBe(1);
  });

  it('PR creation API failure keeps the pushed branch and is retryable', async () => {
    const s = setup();
    s.gh.failNext(
      'createDraftPullRequest',
      new PublishError('SERVER', 'boom', true),
      new PublishError('SERVER', 'boom', true),
      new PublishError('SERVER', 'boom', true),
    );
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'FAILED' });
    expect(s.gh.prs).toHaveLength(0);
  });

  it('expired or revoked credentials end AUTH_EXPIRED without writes', async () => {
    const s = setup();
    s.gh.failNext('viewer', new PublishError('AUTH_EXPIRED', 'Bad credentials'));
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'AUTH_EXPIRED' });
    expect(writes(s.gh)).toEqual([]);
  });

  it('missing permission (403 on branch creation) is BLOCKED, not retried', async () => {
    const s = setup();
    s.gh.failNext('createBranch', new PublishError('FORBIDDEN', 'Resource not accessible by integration'));
    expect(await runPublication(s.deps, 'pub1')).toMatchObject({ status: 'BLOCKED', code: 'FORBIDDEN' });
    expect(s.gh.count('createBranch')).toBe(1);
    expect(s.gh.prs).toHaveLength(0);
  });

  it('P: for any schedule of transient failures, repeated runs yield at most one PR with stable identity', () =>
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom(
              'getRepo',
              'getBranchSha',
              'createTree',
              'createCommit',
              'createBranch',
              'findPullRequest',
              'createDraftPullRequest',
            ),
            fc.constantFrom('NETWORK', 'SERVER', 'RATE_LIMITED'),
          ),
          { maxLength: 8 },
        ),
        async (schedule) => {
          const s = setup();
          for (const [m, code] of schedule)
            s.gh.failNext(m, new PublishError(code as 'NETWORK', 'x', true, 1));
          const identities = new Set<number>();
          for (let i = 0; i < 6; i++) {
            const rec = s.store.records.get('pub1')!;
            if (rec.status !== 'CREATED') rec.status = 'QUEUED';
            const out = await runPublication(s.deps, 'pub1');
            if (out.status === 'CREATED') identities.add(out.prNumber);
          }
          expect(s.gh.prs.length).toBeLessThanOrEqual(1);
          expect(identities.size).toBeLessThanOrEqual(1);
          // Failed attempts are counted by `calls`; what matters is the number of refs that exist.
          expect(s.gh.repos.get('acme/widget')!.branches.size).toBeLessThanOrEqual(2);
          expect(s.gh.repos.get('acme/widget')!.branches.get('main')).toBe(s.baseSha);
        },
      ),
      { numRuns: 60 },
    ));
});

describe('publication state machine', () => {
  it('P: only listed transitions are allowed; CREATED and CANCELLED are absorbing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PUBLICATION_STATUSES),
        fc.constantFrom(...PUBLICATION_STATUSES),
        (a, b) => {
          expect(canTransition(a, b)).toBe(TRANSITIONS[a].includes(b));
        },
      ),
    );
    expect(TRANSITIONS.CREATED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
    // A random walk never leaves the legal graph.
    fc.assert(
      fc.property(fc.array(fc.nat(10), { maxLength: 30 }), (picks) => {
        let cur: PublicationStatus = 'NOT_REQUESTED';
        for (const p of picks) {
          const next: readonly PublicationStatus[] = TRANSITIONS[cur];
          if (next.length === 0) break;
          cur = next[p % next.length]!;
        }
        expect(PUBLICATION_STATUSES).toContain(cur);
        if (cur === 'CREATED') expect(isTerminal(cur)).toBe(true);
      }),
    );
  });
});

describe('publish policy', () => {
  const okSteps = {
    install: { status: 'passed' as const },
    build: { status: 'passed' as const },
    test: { status: 'skipped' as const, skipReason: 'no-test-suite' as const },
  };
  const base: PublishPolicyInput = {
    mode: 'REVIEW_PR',
    actorUserId: 'u1',
    jobOwnerId: 'u1',
    approved: true,
    autoEnabledAtSubmission: false,
    health: 'REVIVED',
    allowPartial: false,
    finalSteps: okSteps,
    publishableFiles: 1,
    baseKnown: true,
  };
  it('allows the happy path and explains every denial', () => {
    expect(evaluatePublishPolicy(base)).toEqual({ allowed: true, reasons: [] });
    expect(evaluatePublishPolicy({ ...base, mode: 'PATCH_ONLY' }).allowed).toBe(false);
    expect(evaluatePublishPolicy({ ...base, approved: false }).reasons[0]).toMatch(/approved/);
    expect(evaluatePublishPolicy({ ...base, mode: 'AUTO_PR' }).allowed).toBe(false);
    expect(evaluatePublishPolicy({ ...base, mode: 'AUTO_PR', autoEnabledAtSubmission: true }).allowed).toBe(
      true,
    );
    expect(evaluatePublishPolicy({ ...base, publishableFiles: 0 }).allowed).toBe(false);
    expect(evaluatePublishPolicy({ ...base, health: 'PARTIALLY_REVIVED' }).allowed).toBe(false);
    expect(evaluatePublishPolicy({ ...base, health: 'PARTIALLY_REVIVED', allowPartial: true }).allowed).toBe(
      true,
    );
  });
  it('P: unauthorized or non-owner actors can never publish, whatever else is true', () => {
    fc.assert(
      fc.property(
        fc.record({
          mode: fc.constantFrom('PATCH_ONLY', 'REVIEW_PR', 'AUTO_PR'),
          actor: fc.constantFrom(null, 'u1', 'u2'),
          owner: fc.constantFrom(null, 'u1'),
          approved: fc.boolean(),
          auto: fc.boolean(),
          health: fc.constantFrom('DEAD', 'PARTIALLY_REVIVED', 'REVIVED', 'UNRECOVERABLE'),
          partial: fc.boolean(),
          files: fc.nat(3),
        }),
        (r) => {
          const d = evaluatePublishPolicy({
            ...base,
            mode: r.mode as PublishPolicyInput['mode'],
            actorUserId: r.actor,
            jobOwnerId: r.owner,
            approved: r.approved,
            autoEnabledAtSubmission: r.auto,
            health: r.health as PublishPolicyInput['health'],
            allowPartial: r.partial,
            publishableFiles: r.files,
          });
          if (d.allowed) {
            expect(r.actor).not.toBeNull();
            expect(r.actor).toBe(r.owner);
            expect(r.mode).not.toBe('PATCH_ONLY');
            expect(r.files).toBeGreaterThan(0);
            expect(r.health === 'REVIVED' || (r.health === 'PARTIALLY_REVIVED' && r.partial)).toBe(true);
            if (r.mode === 'REVIEW_PR') expect(r.approved).toBe(true);
            if (r.mode === 'AUTO_PR') expect(r.auto).toBe(true);
          }
        },
      ),
    );
  });
  it('does not allow publishing when install failed even if health says revived', () => {
    expect(
      evaluatePublishPolicy({ ...base, finalSteps: { ...okSteps, install: { status: 'failed' } } }).allowed,
    ).toBe(false);
  });
});

describe('change partitioning', () => {
  const pathArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}(\/[a-z][a-z0-9_.-]{0,8}){0,2}$/);
  it('P: published entries equal accepted changes (except excluded workflows)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            path: pathArb,
            before: fc.option(
              fc.string({ maxLength: 20 }).filter((s) => !s.includes('\0')),
              { nil: null },
            ),
            after: fc.option(
              fc.string({ maxLength: 20 }).filter((s) => !s.includes('\0')),
              { nil: null },
            ),
          }),
          { selector: (c) => c.path, maxLength: 10 },
        ),
        (changes) => {
          const { publishable } = partitionChanges(changes);
          const entries = describeEntries(toTreeEntries(publishable, new Map()));
          const expected = Object.fromEntries(
            changes.filter((c) => c.before !== c.after).map((c) => [c.path, c.after]),
          );
          expect(entries).toEqual(expected);
        },
      ),
    );
  });
  it('P: paths that escape the repository are always rejected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '../x',
          'a/../../b',
          '/etc/passwd',
          'C:\\x',
          'a\\b',
          '.git/config',
          'node_modules/x/y.js',
          'a//b',
          './a',
        ),
        (p) => {
          expect(() => partitionChanges([{ path: p, before: null, after: 'x' }])).toThrow(PublishError);
        },
      ),
    );
  });
  it('rejects binary content and oversize files', () => {
    expect(() => partitionChanges([{ path: 'a.bin', before: null, after: 'a\0b' }])).toThrow(/binary/);
    expect(() => partitionChanges([{ path: 'big.txt', before: null, after: 'x'.repeat(1_000_001) }])).toThrow(
      /too large/,
    );
  });
});
