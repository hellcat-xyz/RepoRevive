import { pickEraVersion } from '../../core/era';
import type { FileEdit } from '../../core/types';
import type { FixStrategy } from '../types';
import { readRustProject } from './project';
import { eraRustMinor, minorOf, minRustForEdition, DEFAULT_RUST_MINOR, MIN_RUST_MINOR } from './runtime';

const cur = (v: string) => Number(v.split('.')[1]);

function toolchainEdit(existing: { source: string } | null, minor: number): FileEdit {
  // Edit the file rustup already honours; two toolchain files at once would be ambiguous.
  if (existing?.source === 'rust-toolchain') return { path: 'rust-toolchain', content: `1.${minor}\n` };
  return { path: 'rust-toolchain.toml', content: `[toolchain]\nchannel = "1.${minor}"\n` };
}

export const rustPinToolchain: FixStrategy = {
  id: 'rust-pin-toolchain',
  handles: ['toolchain-mismatch', 'unsupported-edition', 'compile-error'],
  invasiveness: 2,
  async propose(issue, ctx) {
    const project = await readRustProject(ctx.ws);
    const now = cur(ctx.runtime.version);
    let target: number | null = null;
    let why = '';
    if (issue.kind === 'unsupported-edition') {
      const min = minRustForEdition(issue.data?.edition ?? null);
      if (min !== null && min > now) {
        target = min;
        why = `Edition ${issue.data?.edition} needs Rust 1.${min} or newer.`;
      }
    } else if (issue.kind === 'toolchain-mismatch') {
      const need = minorOf(issue.data?.required?.includes('.') ? issue.data.required : '');
      if (need !== null && need > now) {
        target = need;
        why = `The build requires rustc ${issue.data?.required}.`;
      }
    } else {
      // compile-error: only the era toolchain is a deterministic candidate, and only if older.
      const era = eraRustMinor(ctx.commitDate);
      if (era < now && project.lockfile) {
        target = era;
        why = `Newer compilers reject code that older ones accepted; the repository dates from ${ctx.commitDate?.slice(0, 10)}, when Rust 1.${era} was current.`;
      }
    }
    if (target === null || target === now || target < MIN_RUST_MINOR || target > DEFAULT_RUST_MINOR + 30) {
      ctx.log(`No usable Rust toolchain pin for "${issue.title}".`);
      return [];
    }
    const edit = toolchainEdit(project.channel, target);
    return [
      {
        strategyId: this.id,
        title: `Pin Rust 1.${target} via ${edit.path}`,
        rationale: `${why} ${edit.path} selects Rust 1.${target} (was 1.${now}).`,
        edits: [edit],
        kind: 'runtime',
      },
    ];
  },
};

export const rustRegenerateLock: FixStrategy = {
  id: 'rust-regenerate-lock',
  handles: ['lockfile-drift', 'lockfile-corrupt'],
  invasiveness: 1,
  async propose(issue, ctx) {
    // Corrupt locks are removed so `cargo fetch` rebuilds them; drift keeps existing pins where possible.
    const pre: FileEdit[] = issue.kind === 'lockfile-corrupt' ? [{ path: 'Cargo.lock', content: null }] : [];
    const lock = await ctx.sandbox.regenerateLockfile(pre);
    if (!lock) {
      ctx.log('Cargo.lock regeneration produced no change.');
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: 'Regenerate Cargo.lock',
        rationale: `${issue.title}. "cargo fetch" in the sandbox rewrites the lockfile to match the manifests, keeping existing pins where they still apply.`,
        edits: [lock],
        kind: 'runtime',
      },
    ];
  },
};

/** Replace the version requirement of dependency `name` in Cargo.toml text. Null when not found. */
export function setCrateVersion(toml: string, name: string, version: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const simple = new RegExp(`^(\\s*${esc}\\s*=\\s*)"[^"]*"`, 'm');
  if (simple.test(toml)) return toml.replace(simple, `$1"${version}"`);
  const inline = new RegExp(`^(\\s*${esc}\\s*=\\s*\\{[^}\\n]*?\\bversion\\s*=\\s*)"[^"]*"`, 'm');
  if (inline.test(toml)) return toml.replace(inline, `$1"${version}"`);
  const table = new RegExp(
    `(^\\[(?:[\\w-]+\\.)?dependencies\\.${esc}\\][^\\[]*?\\bversion\\s*=\\s*)"[^"]*"`,
    'm',
  );
  return table.test(toml) ? toml.replace(table, `$1"${version}"`) : null;
}

export const rustRepinCrate: FixStrategy = {
  id: 'rust-repin-crate',
  handles: ['missing-version'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const name = issue.data?.package;
    if (!name) return [];
    const p = await ctx.registry.packument(name);
    if (!p) {
      ctx.log(`Crate "${name}" does not exist on crates.io; not guessing a replacement.`);
      return [];
    }
    const pick = pickEraVersion(p, ctx.commitDate);
    if (!pick) return [];
    const project = await readRustProject(ctx.ws);
    const edits: FileEdit[] = [];
    for (const m of project.manifests) {
      const text = await ctx.ws.current(m.path);
      const next = text === null ? null : setCrateVersion(text, name, pick.version);
      if (next !== null && next !== text) edits.push({ path: m.path, content: next });
    }
    if (edits.length === 0) return [];
    const withLock = project.lockfile ? await ctx.sandbox.regenerateLockfile(edits) : null;
    return [
      {
        strategyId: this.id,
        title: `Re-pin crate ${name} to ${pick.version}`,
        rationale: `${issue.title}. ${pick.version} is the ${pick.basis === 'era' ? "newest non-yanked release published before the repository's last commit" : 'newest non-yanked release'}.`,
        edits: withLock ? [...edits, withLock] : edits,
        kind: 'runtime',
      },
    ];
  },
};

export const rustDropUnknownFeature: FixStrategy = {
  id: 'rust-drop-unknown-feature',
  handles: ['missing-feature'],
  invasiveness: 1,
  async propose(issue, ctx) {
    const feature = issue.data?.feature?.split(/[,\s]+/).filter(Boolean)[0];
    const dep = issue.data?.package;
    if (!feature || !dep) return [];
    const project = await readRustProject(ctx.ws);
    const edits: FileEdit[] = [];
    for (const m of project.manifests) {
      const text = await ctx.ws.current(m.path);
      if (text === null) continue;
      const re = new RegExp(
        `(^\\s*${dep.replace(/[-]/g, '\\-')}\\s*=\\s*\\{[^}\\n]*?features\\s*=\\s*\\[)([^\\]]*)(\\])`,
        'm',
      );
      const hit = re.exec(text);
      if (!hit) continue;
      const kept = hit[2]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s.replace(/["']/g, '') !== feature);
      if (kept.length === hit[2]!.split(',').filter((s) => s.trim()).length) continue;
      edits.push({ path: m.path, content: text.replace(re, `$1${kept.join(', ')}$3`) });
    }
    if (edits.length === 0) return [];
    return [
      {
        strategyId: this.id,
        title: `Remove nonexistent feature "${feature}" of ${dep}`,
        rationale: `Cargo reports that "${dep}" has no feature "${feature}" (often removed upstream). Dropping it from the dependency declaration is the minimal fix; verification confirms nothing relied on it.`,
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const rustAddMissingCrate: FixStrategy = {
  id: 'rust-add-crate',
  handles: ['missing-module'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const crate = issue.data?.crate;
    if (!crate) return [];
    const project = await readRustProject(ctx.ws);
    const root = project.root;
    if (!root || !('package' in root.toml)) return [];
    if (project.dependencies.some((d) => d.name === crate || d.name === crate.replace(/_/g, '-'))) return [];
    const name = crate.replace(/_/g, '-');
    const p = (await ctx.registry.packument(name)) ?? (await ctx.registry.packument(crate));
    const pick = p && pickEraVersion(p, ctx.commitDate);
    if (!p || !pick) {
      ctx.log(`Crate "${crate}" was not found on crates.io; not adding it.`);
      return [];
    }
    const text = await ctx.ws.current('Cargo.toml');
    if (text === null) return [];
    const line = `${p.name} = "${pick.version}"`;
    const next = /^\[dependencies\]\s*$/m.test(text)
      ? text.replace(/^\[dependencies\]\s*$/m, `[dependencies]\n${line}`)
      : `${text.replace(/\s*$/, '')}\n\n[dependencies]\n${line}\n`;
    const edits: FileEdit[] = [{ path: 'Cargo.toml', content: next }];
    const lock = project.lockfile ? await ctx.sandbox.regenerateLockfile(edits) : null;
    return [
      {
        strategyId: this.id,
        title: `Add missing crate ${p.name} ${pick.version}`,
        rationale: `The code uses "${crate}", which Cargo.toml does not declare. The crate exists on crates.io; ${pick.version} is the ${pick.basis === 'era' ? 'newest release published before the last commit' : 'newest release'}.`,
        edits: lock ? [...edits, lock] : edits,
        kind: 'runtime',
      },
    ];
  },
};

export const rustStrategies: FixStrategy[] = [
  rustRegenerateLock,
  rustDropUnknownFeature,
  rustPinToolchain,
  rustRepinCrate,
  rustAddMissingCrate,
];
