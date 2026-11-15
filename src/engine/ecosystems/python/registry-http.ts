import { z } from 'zod';
import type { PackageRegistry, Packument } from '../../core/ports';

const PyPiSchema = z.object({
  info: z.object({ name: z.string() }).passthrough(),
  releases: z.record(
    z.string(),
    z.array(
      z
        .object({
          upload_time_iso_8601: z.string().optional(),
          yanked: z.boolean().optional(),
        })
        .passthrough(),
    ),
  ),
});

export const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/** Read-only PyPI JSON client. Host-side GET of metadata only; never downloads distributions. */
export class HttpPypiRegistry implements PackageRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();

  constructor(
    private readonly baseUrl = 'https://pypi.org/pypi',
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  packument(name: string): Promise<Packument | null> {
    if (!PYPI_NAME_RE.test(name)) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = this.load(name);
      this.cache.set(name, p);
    }
    return p;
  }

  private async load(name: string): Promise<Packument | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(name)}/json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`PyPI responded ${res.status} for ${name}`);
    const parsed = PyPiSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const versions: string[] = [];
    const time: Record<string, string> = {};
    for (const [v, files] of Object.entries(parsed.data.releases)) {
      const live = files.filter((f) => !f.yanked);
      if (live.length === 0) continue; // all files yanked or removed
      versions.push(v);
      const t = live.map((f) => f.upload_time_iso_8601).find((x): x is string => Boolean(x));
      if (t) time[v] = t;
    }
    return { name: parsed.data.info.name, versions, time, distTags: {} };
  }
}
