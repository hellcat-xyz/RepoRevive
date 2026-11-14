import semver from 'semver';
import type { RuntimeSelection } from '../../core/types';

export const SUPPORTED_NODE_MAJORS = [8, 10, 12, 14, 16, 18, 20, 22] as const;
export const DEFAULT_NODE_MAJOR = 22;

const LTS_CODENAMES: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
};

/** Date each major entered LTS; used to infer the Node version of a repository's era. */
const LTS_START: [number, string][] = [
  [8, '2017-10-31'],
  [10, '2018-10-30'],
  [12, '2019-10-21'],
  [14, '2020-10-27'],
  [16, '2021-10-26'],
  [18, '2022-10-25'],
  [20, '2023-10-24'],
  [22, '2024-10-29'],
];

export function nodeImage(major: number): string {
  return `node:${major}`;
}

export function runtimeFor(major: number, source: string, warnings: string[] = []): RuntimeSelection {
  return { image: nodeImage(major), label: `Node.js ${major}`, major, source, warnings };
}

export function nearestSupported(major: number): number {
  let best: number = SUPPORTED_NODE_MAJORS[0];
  for (const m of SUPPORTED_NODE_MAJORS) {
    if (
      Math.abs(m - major) < Math.abs(best - major) ||
      (Math.abs(m - major) === Math.abs(best - major) && m > best)
    ) {
      best = m;
    }
  }
  return best;
}

/** The newest LTS major that was available at `isoDate`. */
export function eraNodeMajor(isoDate: string | null): number {
  if (!isoDate) return DEFAULT_NODE_MAJOR;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return DEFAULT_NODE_MAJOR;
  let major = 8;
  for (const [m, start] of LTS_START) if (Date.parse(start) <= t) major = m;
  return major;
}

export interface NodeVersionResolution {
  major: number;
  warning?: string;
}

/**
 * Map a declared Node version/range (from .nvmrc, engines, ...) to a supported major.
 * Returns null when the value carries no usable constraint (e.g. "lts/*", "node").
 */
export function resolveNodeDeclaration(value: string): NodeVersionResolution | null {
  const v = value.trim().replace(/^v(?=\d)/i, '');
  if (!v) return null;
  const lower = v.toLowerCase();
  if (['node', 'stable', 'latest', 'current', 'lts/*', 'lts'].includes(lower))
    return { major: DEFAULT_NODE_MAJOR };
  if (lower.startsWith('lts/')) {
    const m = LTS_CODENAMES[lower.slice(4)];
    if (m === undefined) return null;
    return supportedOrNearest(m, value);
  }

  // Treat bare majors ("12") and partials ("12.1") as x-ranges.
  const range = semver.validRange(v, { loose: true });
  if (!range) return null;
  const satisfying = [...SUPPORTED_NODE_MAJORS]
    .reverse()
    .find((m) => semver.intersects(range, `${m}.x`, { loose: true }));
  if (satisfying !== undefined) return { major: satisfying };
  const min = semver.minVersion(range, { loose: true });
  if (!min) return null;
  return supportedOrNearest(min.major, value);
}

function supportedOrNearest(major: number, original: string): NodeVersionResolution {
  if ((SUPPORTED_NODE_MAJORS as readonly number[]).includes(major)) return { major };
  const nearest = nearestSupported(major);
  return {
    major: nearest,
    warning: `Declared Node "${original}" is not available in the sandbox; using Node.js ${nearest} instead.`,
  };
}

export interface RuntimeDeclaration {
  source: string;
  value: string;
}

/** Pure: pick the runtime from declarations in priority order. */
export function selectNodeRuntime(declarations: RuntimeDeclaration[]): RuntimeSelection {
  const warnings: string[] = [];
  for (const d of declarations) {
    const r = resolveNodeDeclaration(d.value);
    if (!r) {
      warnings.push(`Ignoring unrecognised Node declaration "${d.value}" in ${d.source}.`);
      continue;
    }
    if (r.warning) warnings.push(r.warning);
    return runtimeFor(r.major, d.source, warnings);
  }
  return runtimeFor(DEFAULT_NODE_MAJOR, 'default (current LTS)', warnings);
}

/** Highest Node major that a given node-sass version can build against. */
export function maxNodeForNodeSass(version: string): number | null {
  const v = semver.minVersion(version, { loose: true }) ?? semver.coerce(version);
  if (!v) return null;
  const table: [string, number][] = [
    ['9.0.0', 20],
    ['8.0.0', 18],
    ['7.0.0', 17],
    ['6.0.0', 16],
    ['5.0.0', 15],
    ['4.14.0', 14],
    ['4.12.0', 12],
    ['4.9.0', 10],
    ['4.5.3', 9],
    ['4.0.0', 8],
  ];
  for (const [min, node] of table) if (semver.gte(v, min)) return node;
  return 8;
}

/** Largest supported major <= n. */
export function supportedAtMost(n: number): number | null {
  const c = [...SUPPORTED_NODE_MAJORS].reverse().find((m) => m <= n);
  return c ?? null;
}
