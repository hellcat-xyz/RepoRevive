import { z } from 'zod';
import type { PackageRegistry, Packument } from '../../core/ports';

const Solr = z.object({
  response: z.object({ docs: z.array(z.object({ v: z.string(), timestamp: z.number() }).passthrough()) }),
});
const PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** Read-only Maven Central search client. Package name format: `groupId:artifactId`. */
export class HttpMavenRegistry implements PackageRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();
  constructor(
    private readonly baseUrl = 'https://search.maven.org/solrsearch/select',
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  packument(name: string): Promise<Packument | null> {
    const [g, a, ...rest] = name.split(':');
    if (!g || !a || rest.length || !PART.test(g) || !PART.test(a)) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = this.load(g, a, name);
      this.cache.set(name, p);
    }
    return p;
  }

  private async load(g: string, a: string, name: string): Promise<Packument | null> {
    const q = encodeURIComponent(`g:"${g}" AND a:"${a}"`);
    const res = await this.fetchImpl(`${this.baseUrl}?q=${q}&core=gav&rows=200&wt=json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Maven Central responded ${res.status} for ${name}`);
    const p = Solr.safeParse(await res.json());
    if (!p.success || p.data.response.docs.length === 0) return null;
    const time: Record<string, string> = {};
    for (const d of p.data.response.docs) time[d.v] = new Date(d.timestamp).toISOString();
    return { name, versions: p.data.response.docs.map((d) => d.v), time, distTags: {} };
  }
}
