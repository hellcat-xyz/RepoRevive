import semver from 'semver';
import type { Packument } from '../../core/ports';

export interface VersionChoice {
  version: string;
  /** How it was chosen, for the report. */
  basis: 'era' | 'latest-in-range' | 'latest';
}

/**
 * Pick the version a project from `eraDate` would most plausibly have used: the highest stable
 * version published on or before that date (optionally within `range`). Falls back to the highest
 * stable version in range, then to `latest`.
 */
export function eraMatchedVersion(
  p: Packument,
  eraDate: string | null,
  opts: { range?: string; notBefore?: string } = {},
): VersionChoice | null {
  const range = opts.range && semver.validRange(opts.range) ? opts.range : null;
  const stable = p.versions
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .filter((v) => !range || semver.satisfies(v, range))
    .sort(semver.rcompare);

  let cutoff = eraDate ? Date.parse(eraDate) : NaN;
  if (opts.notBefore) {
    const nb = Date.parse(opts.notBefore);
    if (!Number.isNaN(nb) && (Number.isNaN(cutoff) || cutoff < nb)) cutoff = nb;
  }
  if (!Number.isNaN(cutoff)) {
    const era = stable.find((v) => {
      const t = p.time[v] ? Date.parse(p.time[v]!) : NaN;
      return !Number.isNaN(t) && t <= cutoff;
    });
    if (era) return { version: era, basis: 'era' };
  }
  if (stable[0]) return { version: stable[0], basis: range ? 'latest-in-range' : 'latest' };
  const latest = p.distTags.latest;
  return latest ? { version: latest, basis: 'latest' } : null;
}

/** Keep the user's range style: "^1.2.3" stays caret, "~1.2.3" stays tilde, exact stays exact. */
export function rangeLike(previous: string | undefined, version: string): string {
  const prefix = previous?.trim().match(/^[\^~]/)?.[0];
  if (prefix) return `${prefix}${version}`;
  if (previous && semver.valid(previous.trim())) return version;
  return `^${version}`;
}
