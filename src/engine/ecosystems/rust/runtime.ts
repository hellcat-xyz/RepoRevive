import type { RuntimeSelection } from '../../core/types';

/** Newest stable Rust that has an approved `rust:<ver>-slim` image. Update deliberately (see core/images.ts). */
export const DEFAULT_RUST_MINOR = 85;
export const MIN_RUST_MINOR = 31;

/** Stable release dates (anchors); a repository's era maps to the newest anchor released by then. */
const RELEASES: [number, string][] = [
  [31, '2018-12-06'],
  [40, '2019-12-19'],
  [45, '2020-07-16'],
  [50, '2021-02-11'],
  [56, '2021-10-21'],
  [60, '2022-04-07'],
  [65, '2022-11-03'],
  [70, '2023-06-01'],
  [75, '2023-12-28'],
  [80, '2024-07-25'],
  [85, '2025-02-20'],
];

const EDITION_MIN: Record<string, number> = { '2015': 31, '2018': 31, '2021': 56, '2024': 85 };

export function rustImage(minor: number): string {
  return `rust:1.${minor}-slim`;
}

export function rustRuntimeFor(minor: number, source: string, warnings: string[] = []): RuntimeSelection {
  return {
    family: 'rust',
    version: `1.${minor}`,
    image: rustImage(minor),
    label: `Rust 1.${minor}`,
    major: 1,
    source,
    warnings,
  };
}

export function eraRustMinor(isoDate: string | null): number {
  const t = isoDate ? Date.parse(isoDate) : NaN;
  if (Number.isNaN(t)) return DEFAULT_RUST_MINOR;
  let minor = MIN_RUST_MINOR;
  for (const [m, d] of RELEASES) if (Date.parse(d) <= t) minor = m;
  return minor;
}

export function minRustForEdition(edition: string | null): number | null {
  return edition ? (EDITION_MIN[edition] ?? null) : null;
}

/** Parse "1.70", "1.70.0", "1.70.1" -> minor. Null for channels without a numeric version. */
export function minorOf(version: string): number | null {
  const m = /^1\.(\d{1,3})(?:\.\d+)?$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

export interface RustDeclarations {
  channel: { source: string; value: string } | null;
  rustVersion: string | null;
  edition: string | null;
}

/** Pure selection: exact toolchain > rust-version / edition floor > default stable. */
export function selectRustRuntime(d: RustDeclarations): RuntimeSelection {
  const warnings: string[] = [];
  if (d.channel) {
    const minor = minorOf(d.channel.value);
    if (minor !== null && minor >= MIN_RUST_MINOR && minor <= DEFAULT_RUST_MINOR + 30)
      return rustRuntimeFor(minor, d.channel.source, warnings);
    warnings.push(
      `Toolchain "${d.channel.value}" in ${d.channel.source} cannot be provided by the approved images (only numeric stable releases); using stable instead.`,
    );
  }
  let minor = DEFAULT_RUST_MINOR;
  let source = `default (Rust 1.${DEFAULT_RUST_MINOR})`;
  const need = Math.max(
    d.rustVersion ? (minorOf(d.rustVersion.length === 4 ? `${d.rustVersion}.0` : d.rustVersion) ?? 0) : 0,
    minRustForEdition(d.edition) ?? 0,
  );
  if (need > minor) {
    minor = need;
    source = 'Cargo.toml rust-version / edition';
  }
  return rustRuntimeFor(minor, source, warnings);
}
