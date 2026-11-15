import type { Packument } from './ports';

/** Compare dotted numeric versions ("1.10.2" > "1.9"); non-numeric parts compare as 0. */
export function compareLoose(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Stable = digits and dots only (excludes PyPI a/b/rc/dev/post and semver pre-release tags). */
export const isPlainRelease = (v: string): boolean => /^\d+(?:\.\d+)*$/.test(v);

export interface EraChoice {
  version: string;
  basis: 'era' | 'latest';
}

/**
 * Newest stable release published on or before `eraDate`; falls back to the newest stable release.
 * Pure: the packument is supplied by a registry port.
 */
export function pickEraVersion(
  p: Packument,
  eraDate: string | null,
  accept: (v: string) => boolean = () => true,
): EraChoice | null {
  const stable = p.versions.filter((v) => isPlainRelease(v) && accept(v)).sort((a, b) => compareLoose(b, a));
  if (stable.length === 0) return null;
  const cutoff = eraDate ? Date.parse(eraDate) : NaN;
  if (!Number.isNaN(cutoff)) {
    const hit = stable.find((v) => {
      const t = Date.parse(p.time[v] ?? '');
      return !Number.isNaN(t) && t <= cutoff;
    });
    if (hit) return { version: hit, basis: 'era' };
  }
  return { version: stable[0]!, basis: 'latest' };
}
