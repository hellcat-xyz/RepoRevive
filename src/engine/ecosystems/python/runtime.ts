import semver from 'semver';
import type { RuntimeSelection } from '../../core/types';

/** Supported CPython minors available as `python:3.<minor>-slim`. */
export const SUPPORTED_PYTHON_MINORS = [7, 8, 9, 10, 11, 12, 13] as const;
export const DEFAULT_PYTHON_MINOR = 11;
/** Preferred ceiling when a range allows many versions: 3.13 removed many legacy modules. */
const PREFERRED_MAX_MINOR = 12;

/** Release month of each minor; used to infer the interpreter of a repository's era. */
const RELEASES: [number, string][] = [
  [7, '2018-06-27'],
  [8, '2019-10-14'],
  [9, '2020-10-05'],
  [10, '2021-10-04'],
  [11, '2022-10-24'],
  [12, '2023-10-02'],
  [13, '2024-10-07'],
];

export function pythonImage(minor: number): string {
  return `python:3.${minor}-slim`;
}

export function pythonRuntimeFor(minor: number, source: string, warnings: string[] = []): RuntimeSelection {
  return {
    family: 'python',
    version: `3.${minor}`,
    image: pythonImage(minor),
    label: `Python 3.${minor}`,
    major: 3,
    source,
    warnings,
  };
}

/** Newest supported minor that had been released by `isoDate`, never above the preferred ceiling. */
export function eraPythonMinor(isoDate: string | null): number {
  const t = isoDate ? Date.parse(isoDate) : NaN;
  if (Number.isNaN(t)) return DEFAULT_PYTHON_MINOR;
  let minor: number = SUPPORTED_PYTHON_MINORS[0];
  for (const [m, d] of RELEASES) if (Date.parse(d) <= t && m <= PREFERRED_MAX_MINOR) minor = m;
  return minor;
}

/** Convert a PEP 440 specifier set (or Poetry caret/tilde range) into a semver range. Null if unusable. */
export function pep440ToSemverRange(spec: string): string | null {
  const parts = spec
    .trim()
    .replace(/[\s]*([<>=!~^]+)[\s]*/g, '$1')
    .split(/[,\s]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const raw of parts) {
    let p = raw;
    if (p.startsWith('!=')) continue;
    if (p.startsWith('~=')) {
      const v = p.slice(2).split('.');
      const n = v.map((x) => Number(x));
      if (n.some(Number.isNaN)) return null;
      out.push(
        v.length >= 3 ? `>=${v.join('.')} <${n[0]}.${n[1]! + 1}.0` : `>=${v.join('.')} <${n[0]! + 1}.0.0`,
      );
      continue;
    }
    if (p.startsWith('===')) p = p.slice(1);
    if (p.startsWith('==')) p = p.slice(2);
    p = p.replace(/\.\*$/, '.x');
    out.push(p);
  }
  const range = out.join(' ');
  return semver.validRange(range, { loose: true }) ? range : null;
}

export interface PythonResolution {
  minor: number;
  warning?: string;
}

/** Map a declared version or range to a supported minor. Null if the value carries no usable constraint. */
export function resolvePythonDeclaration(value: string): PythonResolution | null {
  const v = value
    .trim()
    .replace(/^(?:python|cpython)[-@ ]?/i, '')
    .replace(/^["']|["']$/g, '');
  if (!v) return null;
  const exact = /^3\.(\d{1,2})(?:\.\d+)?(?:[a-z]+\d*)?$/.exec(v);
  if (exact) return supported(Number(exact[1]), value);
  const range = pep440ToSemverRange(v);
  if (!range) return null;
  const ok = (m: number) => semver.intersects(range, `3.${m}.x`, { loose: true });
  const candidates = SUPPORTED_PYTHON_MINORS.filter(ok);
  if (candidates.length > 0) {
    const preferred = candidates.filter((m) => m <= PREFERRED_MAX_MINOR);
    return { minor: (preferred.length ? preferred : candidates).at(-1)! };
  }
  const min = semver.minVersion(range, { loose: true });
  return min && min.major === 3 ? supported(min.minor, value) : null;
}

function supported(minor: number, original: string): PythonResolution {
  const list = SUPPORTED_PYTHON_MINORS as readonly number[];
  if (list.includes(minor)) return { minor };
  const nearest = minor < list[0]! ? list[0]! : list.at(-1)!;
  return {
    minor: nearest,
    warning: `Declared Python "${original}" is not available in the sandbox; using Python 3.${nearest} instead.`,
  };
}

export interface PythonDeclaration {
  source: string;
  value: string;
}

/** Pure: first usable declaration wins; otherwise the default. */
export function selectPythonRuntime(declarations: PythonDeclaration[]): RuntimeSelection {
  const warnings: string[] = [];
  for (const d of declarations) {
    const r = resolvePythonDeclaration(d.value);
    if (!r) {
      warnings.push(`Ignoring unrecognised Python declaration "${d.value}" in ${d.source}.`);
      continue;
    }
    if (r.warning) warnings.push(r.warning);
    return pythonRuntimeFor(r.minor, d.source, warnings);
  }
  return pythonRuntimeFor(DEFAULT_PYTHON_MINOR, `default (Python 3.${DEFAULT_PYTHON_MINOR})`, warnings);
}

/** True when `minor` is a CPython minor with an approved image. */
export function supportedMinor(minor: number): boolean {
  return (SUPPORTED_PYTHON_MINORS as readonly number[]).includes(minor);
}
