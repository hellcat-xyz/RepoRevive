import type { PackageRegistry, Packument } from '../../core/ports';

const MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9._~\-/]{0,199}$/;

/** Go requires uppercase letters in module paths to be encoded as `!lower`. */
export const escapeModulePath = (p: string) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/** Read-only Go module proxy client: version list plus publish times of the newest releases. */
export class HttpGoProxyRegistry implements PackageRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();

  constructor(
    private readonly baseUrl = 'https://proxy.golang.org',
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxInfo = 40,
  ) {}

  packument(name: string): Promise<Packument | null> {
    if (!MODULE_RE.test(name) || name.includes('..')) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = this.load(name);
      this.cache.set(name, p);
    }
    return p;
  }

  private async get(path: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async load(name: string): Promise<Packument | null> {
    const base = escapeModulePath(name);
    const res = await this.get(`${base}/@v/list`);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Go proxy responded ${res.status} for ${name}`);
    const versions = (await res.text())
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v)); // releases only (no pre-release, no pseudo-versions)
    const time: Record<string, string> = {};
    const newest = [...versions].reverse().slice(0, this.maxInfo);
    await Promise.all(
      newest.map(async (v) => {
        const r = await this.get(`${base}/@v/${v}.info`).catch(() => null);
        if (r?.ok) {
          const t = ((await r.json().catch(() => null)) as { Time?: string } | null)?.Time;
          if (t) time[v.slice(1)] = t;
        }
      }),
    );
    return { name, versions: versions.map((v) => v.slice(1)), time, distTags: {} };
  }
}
