import type { FileEdit, FixProposal, Issue } from '../../core/types';
import type { FixStrategy, StrategyContext } from '../types';
import {
  type DepSection,
  type Manifest,
  findDependency,
  readManifest,
  serializeManifest,
  withDependency,
  withoutDependency,
} from './manifest';
import {
  eraNodeMajor,
  maxNodeForNodeSass,
  resolveNodeDeclaration,
  SUPPORTED_NODE_MAJORS,
  supportedAtMost,
  DEFAULT_NODE_MAJOR,
} from './runtime';
import { upstreamRefPin } from './upstream-strategies';
import { eraMatchedVersion, rangeLike } from './versions';

// ---------------------------------------------------------------- helpers

async function manifestEdits(
  ctx: StrategyContext,
  mutate: (json: Manifest) => Manifest | null,
): Promise<FileEdit[] | null> {
  const m = await readManifest(ctx.ws);
  if (!m) return null;
  const next = mutate(m.json);
  if (!next) return null;
  const content = serializeManifest(m, next);
  if (content === m.raw) return null;
  const pkgEdit: FileEdit = { path: 'package.json', content };
  const lock = await ctx.sandbox.regenerateLockfile([pkgEdit]);
  return lock ? [pkgEdit, lock] : [pkgEdit];
}

function pinNodeProposal(major: number, why: string, previous: string | null): FixProposal {
  return {
    strategyId: 'node-pin',
    title: `Pin Node.js ${major} via .nvmrc`,
    rationale: `${why} Writing ".nvmrc" selects Node.js ${major} for installs, builds, and tests${
      previous ? ` (previously "${previous.trim()}")` : ''
    }.`,
    edits: [{ path: '.nvmrc', content: `${major}\n` }],
    kind: 'runtime',
  };
}

function uniqueMajors(list: (number | null | undefined)[], current: number): number[] {
  const out: number[] = [];
  for (const m of list) if (m != null && m !== current && !out.includes(m)) out.push(m);
  return out.slice(0, 2);
}

function nextSupportedAbove(n: number): number | null {
  return SUPPORTED_NODE_MAJORS.find((m) => m > n) ?? null;
}

// ---------------------------------------------------------------- strategies

export const legacyPeerDeps: FixStrategy = {
  id: 'npmrc-legacy-peer-deps',
  handles: ['peer-conflict'],
  invasiveness: 1,
  async propose(_issue, ctx) {
    const existing = await ctx.ws.current('.npmrc');
    if (existing && /^\s*legacy-peer-deps\s*=\s*true\s*$/m.test(existing)) return [];
    const content = existing
      ? `${existing.replace(/\s*$/, '')}\nlegacy-peer-deps=true\n`
      : 'legacy-peer-deps=true\n';
    return [
      {
        strategyId: this.id,
        title: 'Restore npm 6 peer-dependency behaviour (.npmrc legacy-peer-deps)',
        rationale:
          'npm 7+ refuses to install when peer dependency ranges conflict. The project predates that rule, so ' +
          '`legacy-peer-deps=true` reproduces the resolution its authors originally used without changing any versions.',
        edits: [{ path: '.npmrc', content }],
        kind: 'runtime',
      },
    ];
  },
};

const GIT_REWRITES: [RegExp, string][] = [
  [/git\+git:\/\/github\.com\//g, 'git+https://github.com/'],
  [/(^|["\s])git:\/\/github\.com\//gm, '$1git+https://github.com/'],
  [/git\+ssh:\/\/git@github\.com[/:]/g, 'git+https://github.com/'],
  [/(^|["\s])ssh:\/\/git@github\.com[/:]/gm, '$1git+https://github.com/'],
];

export function rewriteGitProtocols(text: string): string {
  return GIT_REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export const gitHttps: FixStrategy = {
  id: 'git-https-rewrite',
  handles: ['git-protocol'],
  invasiveness: 1,
  async propose(_issue, ctx) {
    const edits: FileEdit[] = [];
    for (const file of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      const raw = await ctx.ws.current(file);
      if (raw === null) continue;
      const next = rewriteGitProtocols(raw);
      if (next !== raw) edits.push({ path: file, content: next });
    }
    if (!edits.length) return [];
    return [
      {
        strategyId: this.id,
        title: 'Fetch git dependencies over HTTPS',
        rationale:
          'GitHub permanently disabled the unauthenticated git:// protocol in 2022, and sandboxes have no SSH keys. ' +
          'Rewriting these URLs to git+https:// points at the same commits.',
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const nodePin: FixStrategy = {
  id: 'node-pin',
  handles: ['openssl-legacy', 'native-build', 'node-sass', 'engine-mismatch', 'modern-syntax'],
  invasiveness: 2,
  async propose(issue, ctx) {
    const current = ctx.runtime.major;
    const previous = await ctx.ws.current('.nvmrc');
    const era = eraNodeMajor(ctx.commitDate);
    let majors: number[] = [];
    let why = '';
    switch (issue.kind) {
      case 'openssl-legacy':
        majors = uniqueMajors([current > 16 ? 16 : null], current);
        why =
          'Node 17+ ships OpenSSL 3, which removed the MD4 hash used by webpack 4 and similar tools. Node.js 16 still supports it.';
        break;
      case 'node-sass': {
        const m = await readManifest(ctx.ws);
        const dep = m ? findDependency(m.json, 'node-sass') : undefined;
        const max = dep ? maxNodeForNodeSass(dep.range) : null;
        const fit = max != null ? supportedAtMost(max) : null;
        majors = uniqueMajors(
          [fit != null && fit < current ? fit : null, era < current ? era : null],
          current,
        );
        why = `node-sass${dep ? `@${dep.range}` : ''} ships native bindings only for older Node.js releases.`;
        break;
      }
      case 'native-build': {
        const below = [...SUPPORTED_NODE_MAJORS].reverse().find((m) => m < current) ?? null;
        majors = uniqueMajors([era < current ? era : null, below], current);
        why = `Native addon ${issue.data?.package ?? ''} fails to compile against Node.js ${current}; it was written for the Node.js of its era.`;
        break;
      }
      case 'engine-mismatch':
      case 'modern-syntax': {
        const wanted = issue.data?.wanted
          ?.split(' || ')
          .map((w) => resolveNodeDeclaration(w)?.major)
          .filter((m): m is number => m != null);
        const fromWanted = wanted && wanted.length ? Math.max(...wanted) : null;
        majors =
          issue.kind === 'modern-syntax'
            ? uniqueMajors(
                [fromWanted, nextSupportedAbove(current), DEFAULT_NODE_MAJOR].filter(
                  (m) => m != null && m > current,
                ),
                current,
              )
            : uniqueMajors([fromWanted], current);
        why =
          issue.kind === 'modern-syntax'
            ? `Dependencies use JavaScript features or APIs that Node.js ${current} does not support.`
            : `Dependencies declare Node.js engine requirements that ${current} does not meet.`;
        break;
      }
      default:
        return [];
    }
    return majors.map((m) => pinNodeProposal(m, why, previous));
  },
};

export const regenerateLockfile: FixStrategy = {
  id: 'lockfile-regenerate',
  handles: ['lockfile-drift', 'missing-version'],
  invasiveness: 3,
  async propose(issue, ctx) {
    if (issue.kind === 'missing-version') {
      const m = await readManifest(ctx.ws);
      // Direct dependencies are handled by pin-missing-version; only stale transitive pins need this.
      if (m && issue.data?.package && findDependency(m.json, issue.data.package)) return [];
    }
    const lock = await ctx.sandbox.regenerateLockfile([]);
    if (!lock) return [];
    return [
      {
        strategyId: this.id,
        title: `Re-sync ${lock.path} with package.json`,
        rationale:
          'The lockfile references versions that no longer match package.json or the registry. It was regenerated ' +
          'with `npm install --package-lock-only --ignore-scripts`, which keeps existing pins where they still satisfy package.json.',
        edits: [lock],
        kind: 'runtime',
      },
    ];
  },
};

export const pinMissingVersion: FixStrategy = {
  id: 'pin-missing-version',
  handles: ['missing-version'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const name = issue.data?.package;
    if (!name) return [];
    const m = await readManifest(ctx.ws);
    const dep = m ? findDependency(m.json, name) : undefined;
    if (!dep) return [];
    const p = await ctx.registry.packument(name);
    if (!p) return [];
    const choice = eraMatchedVersion(p, ctx.commitDate);
    if (!choice) return [];
    const range = rangeLike(dep.range, choice.version);
    const edits = await manifestEdits(ctx, (json) =>
      withDependency(json, dep.section as DepSection, name, range),
    );
    if (!edits) return [];
    return [
      {
        strategyId: this.id,
        title: `Point ${name} at published version ${range}`,
        rationale: `"${name}@${dep.range}" does not exist on the registry. ${choice.version} is the ${
          choice.basis === 'era'
            ? "newest version published before the project's last commit"
            : 'newest published version'
        }.`,
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const addMissingDependency: FixStrategy = {
  id: 'add-missing-dependency',
  handles: ['missing-module', 'missing-binary'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const name = issue.data?.package;
    if (!name) return [];
    const m = await readManifest(ctx.ws);
    if (!m || m.json.name === name || findDependency(m.json, name)) return [];
    const p = await ctx.registry.packument(name);
    if (!p) return [];
    const choice = eraMatchedVersion(p, ctx.commitDate);
    if (!choice) return [];
    if (issue.kind === 'missing-binary' && p.bins && issue.data?.binary) {
      const bins = p.bins[choice.version] ?? [];
      if (bins.length && !bins.includes(issue.data.binary)) return [];
    }
    const section: DepSection =
      issue.kind === 'missing-binary' || name.startsWith('@types/') || issue.step === 'test'
        ? 'devDependencies'
        : 'dependencies';
    const range = `^${choice.version}`;
    const edits = await manifestEdits(ctx, (json) => withDependency(json, section, name, range));
    if (!edits) return [];
    return [
      {
        strategyId: this.id,
        title: `Declare missing ${section === 'devDependencies' ? 'dev ' : ''}dependency ${name}@${range}`,
        rationale: `The ${issue.step} step needs "${name}" but package.json does not declare it (it was probably installed transitively in the past). ${
          choice.basis === 'era'
            ? "The version is the newest published before the last commit, to match the code's era."
            : 'Using the newest published version.'
        }`,
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const pinTypes: FixStrategy = {
  id: 'pin-types',
  handles: ['types-incompatible'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const name = issue.data?.package;
    if (!name || !ctx.commitDate) return [];
    const p = await ctx.registry.packument(name);
    if (!p) return [];
    const choice = eraMatchedVersion(p, ctx.commitDate);
    if (!choice || choice.basis !== 'era') return [];
    const m = await readManifest(ctx.ws);
    const dep = m ? findDependency(m.json, name) : undefined;
    if (dep && dep.range === choice.version) return [];
    const section = (dep?.section ?? 'devDependencies') as DepSection;
    const edits = await manifestEdits(ctx, (json) => withDependency(json, section, name, choice.version));
    if (!edits) return [];
    return [
      {
        strategyId: this.id,
        title: `Pin ${name} to ${choice.version}`,
        rationale: `Floating ${name} resolved to a release that uses TypeScript syntax newer than the project's compiler. ${choice.version} was current when the project was last updated.`,
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const replaceNodeSass: FixStrategy = {
  id: 'replace-node-sass',
  handles: ['node-sass'],
  invasiveness: 4,
  async propose(_issue: Issue, ctx) {
    const m = await readManifest(ctx.ws);
    if (!m || !findDependency(m.json, 'node-sass')) return [];
    const p = await ctx.registry.packument('sass');
    if (!p) return [];
    // sass >= 1.33 era keeps the legacy render() API that sass-loader <= 10 relies on.
    const choice = eraMatchedVersion(p, ctx.commitDate, { range: '^1.33.0', notBefore: '2021-06-01' });
    if (!choice) return [];
    const range = `^${choice.version}`;
    const edits = await manifestEdits(ctx, (json) => {
      const removed = withoutDependency(json, 'node-sass');
      if (!removed.section) return null;
      return withDependency(removed.json, removed.section, 'sass', range);
    });
    if (!edits) return [];
    return [
      {
        strategyId: this.id,
        title: `Replace deprecated node-sass with sass@${range}`,
        rationale:
          'node-sass is deprecated and needs native compilation that fails on modern Node.js. Dart Sass (`sass`) is the ' +
          'official drop-in replacement and is picked up automatically by sass-loader 7.2+ and most build tools.',
        edits,
        kind: 'runtime',
      },
    ];
  },
};

export const npmStrategies: FixStrategy[] = [
  legacyPeerDeps,
  gitHttps,
  upstreamRefPin,
  nodePin,
  regenerateLockfile,
  pinMissingVersion,
  addMissingDependency,
  pinTypes,
  replaceNodeSass,
];
