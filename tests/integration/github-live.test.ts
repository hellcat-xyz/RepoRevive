import { describe, expect, it } from 'vitest';
import { GitHubRest } from '@/engine/publish/github-rest';
import { runPublication } from '@/engine/publish/publisher';
import { makeRecord, MemoryPublicationStore } from '../helpers/fake-github';

/**
 * OPT-IN, WRITES TO GITHUB. Runs only when all of these are set:
 *   REPOREVIVE_GITHUB_LIVE_TESTS=1
 *   GITHUB_TEST_TOKEN   user access token (or fine-grained PAT) with Contents+Pull requests write on the test repo
 *   GITHUB_TEST_REPO    "owner/name" of a repository dedicated to testing that you own
 * It creates one branch and one DRAFT pull request, then runs the publication again to prove idempotency.
 * Close the draft PR and delete the branch afterwards. Never point this at a repository you do not control.
 */
const enabled =
  process.env.REPOREVIVE_GITHUB_LIVE_TESTS === '1' &&
  Boolean(process.env.GITHUB_TEST_TOKEN) &&
  /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_TEST_REPO ?? '');

describe.runIf(enabled)('live GitHub publication (opt-in)', () => {
  it('creates one draft PR and is idempotent on retry', async () => {
    const [owner, name] = process.env.GITHUB_TEST_REPO!.split('/') as [string, string];
    const api = new GitHubRest({ getToken: () => process.env.GITHUB_TEST_TOKEN! });
    const viewer = await api.viewer();
    const repo = await api.getRepo(owner, name);
    expect(repo?.permissions.push, 'the token must have push access to the test repository').toBe(true);
    const baseSha = (await api.getBranchSha(owner, name, repo!.defaultBranch))!;
    const stamp = Date.now().toString(36);
    const store = new MemoryPublicationStore();
    const rec = makeRecord({
      id: 'live',
      resurrectionId: `live${stamp}`,
      idempotencyKey: `live-${stamp}`,
      targetOwner: owner,
      targetRepo: name,
      baseBranch: repo!.defaultBranch,
      baseSha,
      headBranch: `reporevive/live-test-${stamp}`,
      title: 'test(revive): live publication check (safe to close)',
      body: 'Created by the RepoRevive opt-in live test. Safe to close and delete.',
      changes: [{ path: `reporevive-live-test-${stamp}.txt`, before: null, after: `live test ${stamp}\n` }],
    });
    store.records.set(rec.id, rec);
    const deps = { store, api, expectedLogin: viewer.login, workerId: 'live', emit: () => undefined };
    const first = await runPublication(deps, 'live');
    expect(first.status).toBe('CREATED');
    store.records.get('live')!.status = 'QUEUED';
    const second = await runPublication(deps, 'live');
    expect(second).toMatchObject({ status: 'CREATED', reused: true });
    expect(
      first.status === 'CREATED' && second.status === 'CREATED' && first.prNumber === second.prNumber,
    ).toBe(true);
  }, 120_000);
});
