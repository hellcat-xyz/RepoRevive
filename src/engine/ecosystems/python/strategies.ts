import { pickEraVersion } from '../../core/era';
import type { FileEdit, FixProposal } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import type { FixStrategy } from '../types';
import type { PythonProject } from './project';
import { normalizeName, readPythonProject, REQUIREMENT_FILES } from './project';
import { eraPythonMinor, resolvePythonDeclaration, supportedMinor } from './runtime';

const PIN_FILES = [...REQUIREMENT_FILES, 'pyproject.toml'];

function nameRegex(name: string): string {
  return name
    .split(/[-_.]+/)
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ''))
    .join('[-_.]+');
}

/** Rewrite `name<op>version` pins across manifest files. `fn` returns the replacement spec or null. */
async function rewritePins(
  ws: Workspace,
  name: string,
  fn: (op: string, version: string) => string | null,
): Promise<{ edits: FileEdit[]; before: string[] }> {
  const re = new RegExp(
    `(?<![\\w.-])(${nameRegex(name)})(\\[[^\\]]*\\])?(\\s*)(==|~=|>=)(\\s*)([\\w.*]+)`,
    'gi',
  );
  const edits: FileEdit[] = [];
  const before: string[] = [];
  for (const f of PIN_FILES) {
    const text = await ws.current(f);
    if (text === null) continue;
    let changed = false;
    const next = text.replace(
      re,
      (all, n: string, extras: string | undefined, _s1, op: string, _s2, ver: string) => {
        const spec = fn(op, ver);
        if (spec === null) return all;
        changed = true;
        before.push(`${n}${op}${ver}`);
        return `${n}${extras ?? ''}${spec}`;
      },
    );
    if (changed && next !== text) edits.push({ path: f, content: next });
  }
  return { edits, before };
}

async function withLock(
  ctx: Parameters<FixStrategy['propose']>[1],
  edits: FileEdit[],
  project: PythonProject,
): Promise<FileEdit[]> {
  if (!project.lockfile || edits.length === 0) return edits;
  const lock = await ctx.sandbox.regenerateLockfile(edits);
  return lock ? [...edits, lock] : edits;
}

const currentMinor = (v: string) => Number(v.split('.')[1]);

export const pythonPinRuntime: FixStrategy = {
  id: 'python-pin-runtime',
  handles: ['toolchain-mismatch', 'removed-stdlib-api', 'build-script-failure'],
  invasiveness: 2,
  async propose(issue, ctx) {
    const cur = currentMinor(ctx.runtime.version);
    let target: number | null = null;
    let why = '';
    if (issue.kind === 'toolchain-mismatch' && issue.data?.requires) {
      target = resolvePythonDeclaration(issue.data.requires)?.minor ?? null;
      why = `A package declares Requires-Python "${issue.data.requires}".`;
    } else {
      const era = eraPythonMinor(ctx.commitDate);
      if (era < cur) {
        target = era;
        why = `The repository dates from ${ctx.commitDate?.slice(0, 10) ?? 'an earlier era'}, when Python 3.${era} was current.`;
      }
    }
    if (target === null || target === cur || !supportedMinor(target)) {
      ctx.log(`No usable Python pin for "${issue.title}".`);
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: `Pin Python 3.${target} via .python-version`,
        rationale: `${why} Writing ".python-version" selects Python 3.${target} for installs, builds, and tests (was 3.${cur}).`,
        edits: [{ path: '.python-version', content: `3.${target}\n` }],
        kind: 'runtime',
      },
    ];
  },
};

export const pythonRepinMissingVersion: FixStrategy = {
  id: 'python-repin-version',
  handles: ['missing-version'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const name = issue.data?.package;
    if (!name) return [];
    const p = await ctx.registry.packument(name);
    if (!p) {
      ctx.log(`"${name}" was not found on PyPI; not guessing a replacement.`);
      return [];
    }
    const wanted = issue.data?.version;
    if (wanted && p.versions.includes(wanted)) {
      ctx.log(`${name} ${wanted} exists on PyPI, so the failure is not an unavailable version.`);
      return [];
    }
    const pick = pickEraVersion(p, ctx.commitDate);
    if (!pick) return [];
    const { edits, before } = await rewritePins(ctx.ws, name, (op, ver) =>
      op === '==' && ver === wanted
        ? `==${pick.version}`
        : op === '==' && !p.versions.includes(ver)
          ? `==${pick.version}`
          : null,
    );
    if (edits.length === 0) return [];
    const project = await readPythonProject(ctx.ws);
    return [
      {
        strategyId: this.id,
        title: `Re-pin ${name} to ${pick.version}`,
        rationale: `${before.join(', ')} is not available on PyPI. ${pick.version} is the ${pick.basis === 'era' ? "newest stable release published before the repository's last commit" : 'newest stable release'}.`,
        edits: await withLock(ctx, edits, project),
        kind: 'runtime',
      },
    ];
  },
};

export const pythonRelaxConflict: FixStrategy = {
  id: 'python-relax-conflict',
  handles: ['dependency-conflict'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const named = new Set((issue.data?.packages ?? '').split(',').filter(Boolean).map(normalizeName));
    const project = await readPythonProject(ctx.ws);
    const candidates = project.dependencies.filter(
      (d) => /^==/.test(d.range) && (named.size === 0 || named.has(d.name)),
    );
    const proposals: FixProposal[] = [];
    for (const dep of candidates.slice(0, 3)) {
      const p = await ctx.registry.packument(dep.name);
      const pick = p && pickEraVersion(p, ctx.commitDate);
      if (!pick) continue;
      const pinned = dep.range.replace(/^==\s*/, '');
      if (pick.version === pinned) continue;
      const { edits } = await rewritePins(ctx.ws, dep.name, (op, ver) =>
        op === '==' && ver === pinned ? `<=${pick.version}` : null,
      );
      if (edits.length === 0) continue;
      proposals.push({
        strategyId: this.id,
        title: `Relax ${dep.name}==${pinned} to <=${pick.version}`,
        rationale: `The resolver reported conflicting constraints involving ${dep.name}. Relaxing the exact pin to an upper bound (newest release of the repository's era) lets the resolver pick a compatible version.`,
        edits: await withLock(ctx, edits, project),
        kind: 'runtime',
      });
    }
    return proposals;
  },
};

export const pythonRegenerateLock: FixStrategy = {
  id: 'python-regenerate-lock',
  handles: ['lockfile-drift', 'lockfile-corrupt'],
  invasiveness: 1,
  async propose(issue, ctx) {
    const lock = await ctx.sandbox.regenerateLockfile([]);
    if (!lock) {
      ctx.log('Lockfile regeneration produced no change.');
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: `Regenerate ${lock.path}`,
        rationale: `${issue.title}. Regenerating the lockfile in the sandbox (without running project scripts) brings it back in line with the manifest.`,
        edits: [lock],
        kind: 'runtime',
      },
    ];
  },
};

/** Import name -> PyPI distribution, for names that differ. */
export const IMPORT_TO_DIST: Record<string, string> = {
  yaml: 'PyYAML',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  jwt: 'PyJWT',
  OpenSSL: 'pyOpenSSL',
  MySQLdb: 'mysqlclient',
  git: 'GitPython',
  serial: 'pyserial',
  attr: 'attrs',
  magic: 'python-magic',
  Crypto: 'pycryptodome',
  docx: 'python-docx',
  skimage: 'scikit-image',
  zmq: 'pyzmq',
  psycopg2: 'psycopg2-binary',
  markdown: 'Markdown',
};

export const pythonAddMissingDependency: FixStrategy = {
  id: 'python-add-dependency',
  handles: ['missing-module'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const mod = issue.data?.module;
    if (!mod || !/^[A-Za-z_][\w]*$/.test(mod)) return [];
    const project = await readPythonProject(ctx.ws);
    const dist = IMPORT_TO_DIST[mod] ?? mod;
    if (project.dependencies.some((d) => d.name === normalizeName(dist))) {
      ctx.log(`${dist} is already declared; not adding it again.`);
      return [];
    }
    const p = await ctx.registry.packument(dist);
    const pick = p && pickEraVersion(p, ctx.commitDate);
    if (!p || !pick) {
      ctx.log(`"${dist}" does not exist on PyPI; not adding an unverifiable dependency.`);
      return [];
    }
    const line = `${p.name}==${pick.version}`;
    let edit: FileEdit | null = null;
    const req = await ctx.ws.current('requirements.txt');
    const pyText = await ctx.ws.current('pyproject.toml');
    if (req !== null && project.manager === 'pip') {
      edit = { path: 'requirements.txt', content: `${req.replace(/\s*$/, '')}\n${line}\n` };
    } else if (
      pyText !== null &&
      project.pyproject &&
      /^\s*dependencies\s*=\s*\[/m.test(pyText) &&
      project.manager !== 'poetry'
    ) {
      edit = {
        path: 'pyproject.toml',
        content: pyText.replace(/^(\s*dependencies\s*=\s*\[)/m, `$1\n    "${line}",`),
      };
    } else if (pyText !== null && /^\[tool\.poetry\.dependencies\]\s*$/m.test(pyText)) {
      edit = {
        path: 'pyproject.toml',
        content: pyText.replace(
          /^(\[tool\.poetry\.dependencies\]\s*)$/m,
          `$1\n${p.name} = "${pick.version}"`,
        ),
      };
    }
    if (!edit) {
      ctx.log(`No supported manifest to add ${dist} to for ${project.manager}.`);
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: `Add missing dependency ${p.name}==${pick.version}`,
        rationale: `The code imports "${mod}", which is not installed or declared. ${p.name} exists on PyPI; ${pick.version} is the ${pick.basis === 'era' ? 'newest release published before the last commit' : 'newest stable release'}.`,
        edits: await withLock(ctx, [edit], project),
        kind: 'runtime',
      },
    ];
  },
};

export const pythonPytestPath: FixStrategy = {
  id: 'python-pytest-pythonpath',
  handles: ['import-path'],
  invasiveness: 1,
  async propose(issue, ctx) {
    const mod = issue.data?.module;
    const hasSrc = mod
      ? (await ctx.ws.exists(`src/${mod}`)) || (await ctx.ws.exists(`src/${mod}.py`))
      : await ctx.ws.exists('src');
    const root = hasSrc ? 'src' : '.';
    const pytestIni = await ctx.ws.current('pytest.ini');
    const pyText = await ctx.ws.current('pyproject.toml');
    let edit: FileEdit;
    if (pytestIni !== null) {
      if (/^\s*pythonpath\s*=/m.test(pytestIni)) return [];
      if (!/^\[pytest\]/m.test(pytestIni)) return [];
      edit = {
        path: 'pytest.ini',
        content: pytestIni.replace(/^\[pytest\]\s*$/m, `[pytest]\npythonpath = ${root}`),
      };
    } else if (pyText !== null && /^\[tool\.pytest\.ini_options\]/m.test(pyText)) {
      if (/^\s*pythonpath\s*=/m.test(pyText)) return [];
      edit = {
        path: 'pyproject.toml',
        content: pyText.replace(
          /^\[tool\.pytest\.ini_options\]\s*$/m,
          `[tool.pytest.ini_options]\npythonpath = ["${root}"]`,
        ),
      };
    } else {
      edit = { path: 'pytest.ini', content: `[pytest]\npythonpath = ${root}\n` };
    }
    return [
      {
        strategyId: this.id,
        title: `Add ${root} to pytest's import path`,
        rationale: `Tests could not import ${mod ? `"${mod}"` : 'the project'}. Setting pytest's "pythonpath" to "${root}" lets them import it without installing the package.`,
        edits: [edit],
        kind: 'runtime',
      },
    ];
  },
};

const COLLECTIONS_ABC = new Set([
  'Mapping',
  'MutableMapping',
  'Sequence',
  'MutableSequence',
  'Iterable',
  'Iterator',
  'Callable',
  'Set',
  'MutableSet',
  'Hashable',
  'Sized',
  'Container',
  'Generator',
  'Awaitable',
  'Coroutine',
  'KeysView',
  'ItemsView',
  'ValuesView',
  'MappingView',
  'ByteString',
]);

/** Pure source rewrite for removed collections ABC aliases. Returns null when nothing changes. */
export function rewriteCollectionsAbc(src: string): string | null {
  let out = src.replace(
    /^([ \t]*)from collections import ([^\n(\\]+)$/gm,
    (all, indent: string, list: string) => {
      const names = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const abc = names.filter((n) => COLLECTIONS_ABC.has(n.split(/\s+as\s+/)[0]!));
      if (abc.length === 0) return all;
      const rest = names.filter((n) => !abc.includes(n));
      const lines = [];
      if (rest.length) lines.push(`${indent}from collections import ${rest.join(', ')}`);
      lines.push(`${indent}from collections.abc import ${abc.join(', ')}`);
      return lines.join('\n');
    },
  );
  const attr = new RegExp(`\\bcollections\\.(${[...COLLECTIONS_ABC].join('|')})\\b`, 'g');
  if (attr.test(out)) {
    out = out.replace(attr, 'collections.abc.$1');
    if (!/^\s*import collections\.abc\b|^\s*from collections import abc\b/m.test(out))
      out = out.replace(
        /^([ \t]*)import collections[ \t]*$/m,
        '$1import collections\n$1import collections.abc',
      );
  }
  return out === src ? null : out;
}

export const pythonCollectionsAbc: FixStrategy = {
  id: 'python-collections-abc',
  handles: ['removed-stdlib-api'],
  invasiveness: 4,
  async propose(issue, ctx) {
    if (issue.data?.module !== 'collections' || !issue.data.file) return [];
    const text = await ctx.ws.current(issue.data.file).catch(() => null);
    if (text === null) return [];
    const next = rewriteCollectionsAbc(text);
    if (!next) return [];
    return [
      {
        strategyId: this.id,
        title: `Use collections.abc in ${issue.data.file}`,
        rationale:
          'The ABC aliases in "collections" were removed in Python 3.10. They live in "collections.abc" (available since Python 3.3), so the rewrite is behaviour-preserving.',
        edits: [{ path: issue.data.file, content: next }],
        kind: 'runtime',
      },
    ];
  },
};

export const pythonStrategies: FixStrategy[] = [
  pythonRegenerateLock,
  pythonPytestPath,
  pythonPinRuntime,
  pythonRepinMissingVersion,
  pythonRelaxConflict,
  pythonAddMissingDependency,
  pythonCollectionsAbc,
];
