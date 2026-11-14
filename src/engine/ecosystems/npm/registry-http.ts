import { z } from 'zod';
import type { PackageRegistry, Packument } from '../../core/ports';
import { isValidPackageName } from './manifest';

const PackumentSchema = z.object({
  name: z.string(),
  'dist-tags': z.record(z.string(), z.string()).default({}),
  time: z.record(z.string(), z.string()).default({}),
  versions: z.record(
    z.string(),
    z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]).optional() }).passthrough(),
  ),
});

/**
 * Minimal npm registry client. Runs on the host but only fetches JSON metadata (never tarballs),
 * so no repository code is executed.
 */
export class HttpNpmRegistry implements PackageRegistry {
  private readonly cache = new Map<string, Promise<Packument | null>>();

  constructor(
    private readonly baseUrl = 'https://registry.npmjs.org',
    private readonly timeoutMs = 15_000,
  ) {}

  packument(name: string): Promise<Packument | null> {
    if (!isValidPackageName(name)) return Promise.resolve(null);
    let p = this.cache.get(name);
    if (!p) {
      p = this.fetchPackument(name);
      this.cache.set(name, p);
    }
    return p;
  }

  private async fetchPackument(name: string): Promise<Packument | null> {
    const url = `${this.baseUrl}/${name.replace('/', '%2f')}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`npm registry responded ${res.status} for ${name}`);
    const parsed = PackumentSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const bins: Record<string, string[]> = {};
    for (const [v, meta] of Object.entries(parsed.data.versions)) {
      const bin = meta.bin;
      if (typeof bin === 'string') bins[v] = [name.split('/').pop()!];
      else if (bin) bins[v] = Object.keys(bin);
    }
    return {
      name: parsed.data.name,
      versions: Object.keys(parsed.data.versions),
      time: parsed.data.time,
      distTags: parsed.data['dist-tags'],
      bins,
    };
  }
}
