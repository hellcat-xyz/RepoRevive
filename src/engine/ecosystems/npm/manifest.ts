import type { DependencyInfo } from '../types';
import type { Workspace } from '../../core/workspace';

export const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
export type DepSection = (typeof DEP_SECTIONS)[number];

export type Manifest = Record<string, unknown> & {
  name?: unknown;
  scripts?: unknown;
  engines?: unknown;
  volta?: unknown;
  workspaces?: unknown;
};

export interface ParsedManifest {
  raw: string;
  json: Manifest;
  indent: string;
  trailingNewline: boolean;
  eol: '\n' | '\r\n';
}

export function parseManifest(raw: string): ParsedManifest | null {
  try {
    const json: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    const indentMatch = /^[{[]\r?\n([ \t]+)/.exec(raw);
    return {
      raw,
      json: json as Manifest,
      indent: indentMatch?.[1] ?? '  ',
      trailingNewline: /\n$/.test(raw),
      eol: raw.includes('\r\n') ? '\r\n' : '\n',
    };
  } catch {
    return null;
  }
}

/** Serialize preserving the original indentation, line endings, and trailing newline. */
export function serializeManifest(m: ParsedManifest, json: Manifest): string {
  let out = JSON.stringify(json, null, m.indent);
  if (m.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return m.trailingNewline ? out + m.eol : out;
}

export async function readManifest(ws: Workspace): Promise<ParsedManifest | null> {
  const raw = await ws.current('package.json');
  return raw === null ? null : parseManifest(raw);
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

export function scriptsOf(json: Manifest): Record<string, string> {
  return stringRecord(json.scripts);
}

export function dependenciesOf(json: Manifest): DependencyInfo[] {
  const out: DependencyInfo[] = [];
  for (const section of DEP_SECTIONS) {
    for (const [name, range] of Object.entries(stringRecord(json[section])))
      out.push({ name, range, section });
  }
  return out;
}

export function findDependency(json: Manifest, name: string): DependencyInfo | undefined {
  return dependenciesOf(json).find((d) => d.name === name && d.section !== 'peerDependencies');
}

export function enginesNode(json: Manifest): string | null {
  const e = stringRecord(json.engines);
  return e.node ?? null;
}

export function voltaNode(json: Manifest): string | null {
  return stringRecord(json.volta).node ?? null;
}

/** Return a copy of the manifest JSON with `name` set to `range` in `section` (insertion keeps order). */
export function withDependency(json: Manifest, section: DepSection, name: string, range: string): Manifest {
  const copy = structuredClone(json);
  const current = stringRecord(copy[section]);
  if (name in current) {
    current[name] = range;
    copy[section] = current;
  } else {
    // Insert alphabetically, as `npm install --save` does.
    const entries = Object.entries(current);
    entries.push([name, range]);
    entries.sort(([a], [b]) => a.localeCompare(b));
    copy[section] = Object.fromEntries(entries);
  }
  return copy;
}

export function withoutDependency(
  json: Manifest,
  name: string,
): { json: Manifest; section: DepSection | null } {
  const copy = structuredClone(json);
  for (const section of DEP_SECTIONS) {
    const rec = copy[section];
    if (rec && typeof rec === 'object' && !Array.isArray(rec) && name in rec) {
      delete (rec as Record<string, unknown>)[name];
      return { json: copy, section };
    }
  }
  return { json: copy, section: null };
}

export const PLACEHOLDER_TEST_RE = /no test specified/i;

export function isPlaceholderTest(script: string | undefined): boolean {
  return !script || script.trim() === '' || PLACEHOLDER_TEST_RE.test(script);
}

/** `@scope/pkg/sub/path` -> `@scope/pkg`; `pkg/sub` -> `pkg`. Returns null for relative/absolute/URL specifiers. */
export function packageNameFromSpecifier(spec: string): string | null {
  if (
    !spec ||
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('node:') ||
    /^[a-z]+:/i.test(spec)
  ) {
    return null;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return isValidPackageName(name) ? name : null;
}

const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && PKG_NAME_RE.test(name);
}
