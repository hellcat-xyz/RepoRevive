import { z } from 'zod';
import type { PackageRegistry, Packument } from '../../core/ports';

const CratesSchema = z.object({
  crate: z.object({ name: z.string() }).passthrough(),
  versions: z.array(
    z
      .object({ num: z.string(), created_at: z.string().optional(), yanked: z.boolean().optional() })
      .passthrough(),
  ),
});

export const CRATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Read-only crates.io metadata client (JSON only, with the required User-Agent). */
export class HttpCratesRegistry implements PackageRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();

  constructor(
    private readonly baseUrl = 'https://crates.io/api/v1/crates',
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  packument(name: string): Promise<Packument | null> {
    if (!CRATE_NAME_RE.test(name)) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = this.load(name);
      this.cache.set(name, p);
    }
    return p;
  }

  private async load(name: string): Promise<Packument | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json', 'user-agent': 'RepoRevive (metadata lookup)' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`crates.io responded ${res.status} for ${name}`);
    const parsed = CratesSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const live = parsed.data.versions.filter((v) => !v.yanked);
    const time: Record<string, string> = {};
    for (const v of live) if (v.created_at) time[v.num] = v.created_at;
    return { name: parsed.data.crate.name, versions: live.map((v) => v.num), time, distTags: {} };
  }
}
