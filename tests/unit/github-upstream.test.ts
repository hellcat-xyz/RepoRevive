import { describe, expect, it } from 'vitest';
import { GitHubUpstreamResolver } from '@/engine/upstream/github-http';

const SHA = 'a'.repeat(40);

function fakeFetch(handler: (url: URL, init?: RequestInit) => Partial<Response> & { url?: string }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(url, init);
    return { ok: (r.status ?? 200) < 400, status: 200, url: url.toString(), json: async () => [], ...r };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('GitHubUpstreamResolver', () => {
  it('resolves the commit at a date and uses only api.github.com', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname.endsWith('/commits')
        ? { json: async () => [{ sha: SHA }] }
        : { json: async () => ({ type: 'file' }) },
    );
    const r = new GitHubUpstreamResolver({ token: 'secret', fetchImpl: impl });
    expect(await r.commitAt('o', 'r', 'main', '2026-09-29T13:32:35Z')).toBe(SHA);
    expect(calls[0]!.url).toContain(
      '/repos/o/r/commits?sha=main&until=2026-09-29T13%3A32%3A35.000Z&per_page=1',
    );
    expect(calls[0]!.headers.authorization).toBe('Bearer secret');
    expect(await r.fileExists('o', 'r', SHA, 'a/b.js')).toBe(true);
    expect(calls[1]!.url).toBe(`https://api.github.com/repos/o/r/contents/a/b.js?ref=${SHA}`);
    expect(new Set(calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(['api.github.com']));
  });

  it('reports 404 as missing and other statuses as errors', async () => {
    const { impl } = fakeFetch((url) => ({ status: url.pathname.endsWith('missing.js') ? 404 : 503 }));
    const r = new GitHubUpstreamResolver({ fetchImpl: impl });
    expect(await r.fileExists('o', 'r', SHA, 'missing.js')).toBe(false);
    await expect(r.fileExists('o', 'r', SHA, 'other.js')).rejects.toThrow(/503/);
  });

  it('does not count a directory as an existing file', async () => {
    const { impl } = fakeFetch(() => ({ json: async () => [{ type: 'file' }] }));
    expect(await new GitHubUpstreamResolver({ fetchImpl: impl }).fileExists('o', 'r', SHA, 'dir')).toBe(
      false,
    );
  });

  it('refuses unsafe inputs without making any request', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    const r = new GitHubUpstreamResolver({ fetchImpl: impl });
    expect(await r.commitAt('o/../x', 'r', 'main', '2024-01-01T00:00:00Z')).toBeNull();
    expect(await r.commitAt('o', 'r', '../main', '2024-01-01T00:00:00Z')).toBeNull();
    expect(await r.commitAt('o', 'r', 'main', 'not a date')).toBeNull();
    expect(await r.fileExists('o', 'r', 'main', 'a.js')).toBe(false);
    expect(await r.fileExists('o', 'r', SHA, '../etc/passwd')).toBe(false);
    expect(await r.fileExists('o', 'r', SHA, 'a b?x=1')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects responses redirected to another host', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, url: 'https://evil.example/x' }));
    const r = new GitHubUpstreamResolver({ fetchImpl: impl });
    await expect(r.fileExists('o', 'r', SHA, 'a.js')).rejects.toThrow(/redirected/);
  });
});
