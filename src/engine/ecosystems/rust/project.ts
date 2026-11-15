import { parse as parseToml } from 'smol-toml';
import type { Workspace } from '../../core/workspace';
import type { DependencyInfo } from '../types';
import { walkFiles } from '../shared';

type Toml = Record<string, unknown>;
const obj = (v: unknown): Toml => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Toml) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface CargoManifest {
  path: string;
  toml: Toml;
}

export interface RustProject {
  root: CargoManifest | null;
  /** Every Cargo.toml found (root, members, nested crates). */
  manifests: CargoManifest[];
  lockfile: boolean;
  workspaceMembers: string[];
  edition: string | null;
  rustVersion: string | null;
  /** Toolchain channel declared by rust-toolchain(.toml), e.g. "1.70.0", "stable", "nightly-2021-01-01". */
  channel: { source: string; value: string } | null;
  dependencies: DependencyInfo[];
  features: string[];
  buildScripts: string[];
  targets: string[];
  hasCargoConfig: boolean;
  packageName: string | null;
  description: string | null;
  warnings: string[];
}

export function parseChannel(text: string, isToml: boolean): string | null {
  if (isToml) {
    try {
      return str(obj(obj(parseToml(text)).toolchain).channel);
    } catch {
      return null;
    }
  }
  const t = text.trim();
  if (/^\[toolchain\]/m.test(t)) return parseChannel(t, true);
  const line = t.split(/\r?\n/)[0]?.trim();
  return line || null;
}

function depsOf(toml: Toml, out: DependencyInfo[]) {
  const add = (table: unknown, section: DependencyInfo['section']) => {
    for (const [name, v] of Object.entries(obj(table)))
      out.push({ name, range: typeof v === 'string' ? v : (str(obj(v).version) ?? '*'), section });
  };
  add(toml.dependencies, 'dependencies');
  add(toml['dev-dependencies'], 'devDependencies');
  add(toml['build-dependencies'], 'devDependencies');
  add(obj(toml.workspace).dependencies, 'dependencies');
}

export async function readRustProject(ws: Workspace): Promise<RustProject> {
  const warnings: string[] = [];
  const files = await walkFiles(ws, 3000);
  const manifests: CargoManifest[] = [];
  for (const f of files.filter((x) => x === 'Cargo.toml' || x.endsWith('/Cargo.toml')).slice(0, 60)) {
    const text = await ws.current(f).catch(() => null);
    if (text === null) continue;
    try {
      manifests.push({ path: f, toml: parseToml(text) as Toml });
    } catch {
      warnings.push(`${f} is not valid TOML.`);
    }
  }
  const root = manifests.find((m) => m.path === 'Cargo.toml') ?? null;
  const pkg = obj(root?.toml.package);
  const workspace = obj(root?.toml.workspace);
  const deps: DependencyInfo[] = [];
  for (const m of manifests) depsOf(m.toml, deps);
  const features = new Set<string>();
  for (const m of manifests) for (const f of Object.keys(obj(m.toml.features))) features.add(f);
  const buildScripts: string[] = [];
  for (const m of manifests) {
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/') + 1) : '';
    const declared = str(obj(m.toml.package).build);
    if (declared) buildScripts.push(dir + declared);
    else if (files.includes(`${dir}build.rs`)) buildScripts.push(`${dir}build.rs`);
  }
  const targets: string[] = [];
  for (const m of manifests) {
    for (const k of ['lib', 'bin', 'example', 'bench', 'test'] as const) {
      const v = m.toml[k];
      if (Array.isArray(v)) for (const t of v) targets.push(`${k}:${str(obj(t).name) ?? '?'}`);
      else if (v) targets.push(k);
    }
  }
  let channel: RustProject['channel'] = null;
  for (const [f, isToml] of [
    ['rust-toolchain.toml', true],
    ['rust-toolchain', false],
  ] as const) {
    const text = await ws.current(f).catch(() => null);
    const v = text ? parseChannel(text, isToml) : null;
    if (v) {
      channel = { source: f, value: v };
      break;
    }
  }
  const edition = str(pkg.edition) ?? (obj(obj(workspace.package)).edition as string | undefined) ?? null;
  return {
    root,
    manifests,
    lockfile: await ws.exists('Cargo.lock'),
    workspaceMembers: Array.isArray(workspace.members)
      ? workspace.members.filter((m): m is string => typeof m === 'string')
      : [],
    edition,
    rustVersion: str(pkg['rust-version']) ?? str(obj(workspace.package)['rust-version']),
    channel,
    dependencies: deps,
    features: [...features],
    buildScripts,
    targets,
    hasCargoConfig: (await ws.exists('.cargo/config.toml')) || (await ws.exists('.cargo/config')),
    packageName: str(pkg.name),
    description: str(pkg.description),
    warnings,
  };
}
