import { describe, expect, it } from 'vitest';
import { PublishError } from '@/engine/publish/changes';
import { GitHubRest } from '@/engine/publish/github-rest';

type Handler = (
  url: string,
  init: RequestInit,
) => { status: number; body?: unknown; headers?: Record<string, string> };

function api(handler: Handler, token = 'ghu_SECRETTOKEN0123456789') {
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({
      url,
      method: init.method ?? 'GET',
      auth: headers.get('authorization'),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = handler(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
  return { gh: new GitHubRest({ getToken: () => token, fetchImpl }), seen };
}

const sha = 'a'.repeat(40);

describe('GitHubRest', () => {
  it('maps status codes to typed errors without leaking the token', async () => {
    const cases: [number, Record<string, string>, string, boolean][] = [
      [401, {}, 'AUTH_EXPIRED', false],
      [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED', true],
      [429, { 'retry-after': '7' }, 'RATE_LIMITED', true],
      [403, {}, 'FORBIDDEN', false],
      [422, {}, 'VALIDATION', false],
      [502, {}, 'SERVER', true],
    ];
    for (const [status, headers, code, retryable] of cases) {
      const { gh } = api(() => ({ status, body: { message: 'nope' }, headers }));
      const err = await gh.viewer().catch((e) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect(err).toMatchObject({ code, retryable });
      expect(String(err.message)).not.toContain('SECRETTOKEN');
    }
    const { gh } = api(() => ({ status: 429, headers: { 'retry-after': '7' } }));
    expect(await gh.viewer().catch((e) => e)).toMatchObject({ retryAfterMs: 7000 });
  });

  it('turns network failures into retryable NETWORK errors', async () => {
    const gh = new GitHubRest({
      getToken: () => 't',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(await gh.viewer().catch((e) => e)).toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('creates a draft PR with the expected payload and bearer auth', async () => {
    const { gh, seen } = api(() => ({
      status: 201,
      body: {
        number: 7,
        html_url: 'https://github.com/a/b/pull/7',
        draft: true,
        state: 'open',
        head: { sha },
      },
    }));
    const pr = await gh.createDraftPullRequest({
      owner: 'a',
      name: 'b',
      title: 't',
      body: 'x',
      head: 'me:br',
      base: 'main',
    });
    expect(pr).toMatchObject({ number: 7, draft: true });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      auth: 'Bearer ghu_SECRETTOKEN0123456789',
      body: { draft: true, base: 'main', head: 'me:br' },
    });
  });

  it('createBranch maps "already exists" to CONFLICT and only ever POSTs a new ref', async () => {
    const { gh, seen } = api(() => ({ status: 422, body: { message: 'Reference already exists' } }));
    expect(await gh.createBranch('a', 'b', 'reporevive/x', sha).catch((e) => e)).toMatchObject({
      code: 'CONFLICT',
    });
    expect(seen.every((s) => s.method === 'POST' && s.url.endsWith('/git/refs'))).toBe(true);
  });

  it('rejects malformed owners, repos, branches and object ids before any request', async () => {
    const { gh, seen } = api(() => ({ status: 200, body: {} }));
    for (const call of [
      () => gh.getRepo('../x', 'y'),
      () => gh.getRepo('a', 'b/../c'),
      () => gh.getBranchSha('a', 'b', '../../x'),
      () => gh.createBranch('a', 'b', 'ok', 'nothex'),
      () => gh.findPullRequest('a', 'b', 'no-colon'),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(seen).toHaveLength(0);
  });

  it('reads file modes by walking tree levels', async () => {
    const { gh } = api((url) =>
      url.endsWith(`/git/trees/${sha}`)
        ? {
            status: 200,
            body: {
              tree: [
                { path: 'src', mode: '040000', sha: 'b'.repeat(40) },
                { path: 'run.sh', mode: '100755', sha: 'c'.repeat(40) },
              ],
            },
          }
        : { status: 200, body: { tree: [{ path: 'a.js', mode: '100644', sha: 'd'.repeat(40) }] } },
    );
    const modes = await gh.getTreeModes('a', 'b', sha, ['run.sh', 'src/a.js', 'missing.txt']);
    expect(Object.fromEntries(modes)).toEqual({ 'run.sh': '100755', 'src/a.js': '100644' });
  });

  it('getBranchSha returns null for a missing branch', async () => {
    const { gh } = api(() => ({ status: 404, body: { message: 'Not Found' } }));
    expect(await gh.getBranchSha('a', 'b', 'nope')).toBeNull();
  });
});
