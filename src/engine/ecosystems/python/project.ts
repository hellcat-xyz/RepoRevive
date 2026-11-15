import { parse as parseToml } from 'smol-toml';
import type { Workspace } from '../../core/workspace';
import type { DependencyInfo } from '../types';

export type PythonPackageManager = 'pip' | 'poetry' | 'uv' | 'pipenv';

export const REQUIREMENT_FILES = [
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'dev-requirements.txt',
  'requirements-test.txt',
  'test-requirements.txt',
] as const;

type Toml = Record<string, unknown>;
const obj = (v: unknown): Toml => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Toml) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export interface PythonProject {
  files: Set<string>;
  pyproject: Toml | null;
  pipfile: Toml | null;
  requirements: { file: string; text: string }[];
  manager: PythonPackageManager;
  lockfile: string | null;
  /** All declared dependencies (normalised names). */
  dependencies: DependencyInfo[];
  /** `requires-python`-style declarations in priority order. */
  versionDeclarations: { source: string; value: string }[];
  buildBackend: string | null;
  projectName: string | null;
  description: string | null;
  optionalGroups: string[];
  warnings: string[];
}

const PY_PROJECT_FILES = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'tox.ini',
  '.python-version',
  'runtime.txt',
  'pytest.ini',
  'conftest.py',
  ...REQUIREMENT_FILES,
];

export function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Split a PEP 508 requirement into name + specifier. Returns null for options/URLs/comments. */
export function parseRequirement(line: string): { name: string; spec: string; extras: string } | null {
  const l = line
    .replace(/\s+#.*$/, '')
    .replace(/;.*$/, '')
    .trim();
  if (!l || l.startsWith('#') || l.startsWith('-') || /^(?:git\+|https?:|\.|\/)/.test(l)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(l);
  return m ? { name: m[1]!, extras: m[2] ?? '', spec: m[3]!.replace(/^\(|\)$/g, '').trim() } : null;
}

function tryToml(text: string | null): Toml | null {
  if (text === null) return null;
  try {
    return parseToml(text) as Toml;
  } catch {
    return null;
  }
}

export async function readPythonProject(ws: Workspace): Promise<PythonProject> {
  const files = new Set<string>();
  for (const f of PY_PROJECT_FILES) if (await ws.exists(f)) files.add(f);
  const warnings: string[] = [];
  const pyText = files.has('pyproject.toml') ? await ws.current('pyproject.toml') : null;
  const pyproject = tryToml(pyText);
  if (pyText !== null && !pyproject) warnings.push('pyproject.toml is not valid TOML.');
  const pipText = files.has('Pipfile') ? await ws.current('Pipfile') : null;
  const pipfile = tryToml(pipText);
  const requirements: { file: string; text: string }[] = [];
  for (const f of REQUIREMENT_FILES) {
    const text = files.has(f) ? await ws.current(f) : null;
    if (text !== null) requirements.push({ file: f, text });
  }

  const tool = obj(pyproject?.tool);
  const poetry = obj(tool.poetry);
  const project = obj(pyproject?.project);
  const uvTool = tool.uv !== undefined;

  let manager: PythonPackageManager = 'pip';
  if (files.has('uv.lock') || uvTool) manager = 'uv';
  else if (files.has('poetry.lock') || Object.keys(poetry).length > 0) manager = 'poetry';
  else if (files.has('Pipfile.lock') || files.has('Pipfile')) manager = 'pipenv';
  const lockfile =
    { uv: 'uv.lock', poetry: 'poetry.lock', pipenv: 'Pipfile.lock', pip: null }[manager] ?? null;
  const lock = lockfile && files.has(lockfile) ? lockfile : null;

  const deps: DependencyInfo[] = [];
  const add = (name: string, range: string, section: DependencyInfo['section']) => {
    if (normalizeName(name) !== 'python') deps.push({ name: normalizeName(name), range, section });
  };
  for (const r of requirements) {
    const dev = /dev|test/.test(r.file);
    for (const line of r.text.split(/\r?\n/)) {
      const p = parseRequirement(line);
      if (p) add(p.name, p.spec, dev ? 'devDependencies' : 'dependencies');
    }
  }
  for (const s of strArr(project.dependencies)) {
    const p = parseRequirement(s);
    if (p) add(p.name, p.spec, 'dependencies');
  }
  const optional = obj(project['optional-dependencies']);
  for (const [, list] of Object.entries(optional))
    for (const s of strArr(list)) {
      const p = parseRequirement(s);
      if (p) add(p.name, p.spec, 'devDependencies');
    }
  const poetryDeps = obj(poetry.dependencies);
  for (const [n, v] of Object.entries(poetryDeps))
    add(n, typeof v === 'string' ? v : (str(obj(v).version) ?? '*'), 'dependencies');
  const poetryGroups = obj(poetry.group);
  for (const g of Object.values(poetryGroups))
    for (const [n, v] of Object.entries(obj(obj(g).dependencies)))
      add(n, typeof v === 'string' ? v : (str(obj(v).version) ?? '*'), 'devDependencies');
  for (const [n, v] of Object.entries(obj(pipfile?.packages)))
    add(n, typeof v === 'string' ? v : '*', 'dependencies');
  for (const [n, v] of Object.entries(obj(pipfile?.['dev-packages'])))
    add(n, typeof v === 'string' ? v : '*', 'devDependencies');
  for (const s of strArr(obj(obj(tool).uv)['dev-dependencies'])) {
    const p = parseRequirement(s);
    if (p) add(p.name, p.spec, 'devDependencies');
  }

  const decl: { source: string; value: string }[] = [];
  const pv = (await ws.current('.python-version'))
    ?.split(/\r?\n/)
    .find((l) => l.trim() && !l.startsWith('#'));
  if (pv) decl.push({ source: '.python-version', value: pv.trim() });
  const rt = (await ws.current('runtime.txt'))?.trim();
  if (rt && /^python-/i.test(rt)) decl.push({ source: 'runtime.txt', value: rt });
  const rp = str(project['requires-python']);
  if (rp) decl.push({ source: 'pyproject.toml#project.requires-python', value: rp });
  const poetryPy = str(poetryDeps.python);
  if (poetryPy) decl.push({ source: 'pyproject.toml#tool.poetry.dependencies.python', value: poetryPy });
  const pipPy = str(obj(pipfile?.requires).python_version);
  if (pipPy) decl.push({ source: 'Pipfile#requires.python_version', value: pipPy });
  const cfg = await ws.current('setup.cfg');
  const cfgM = cfg && /^\s*python_requires\s*=\s*(.+)$/m.exec(cfg);
  if (cfgM) decl.push({ source: 'setup.cfg#python_requires', value: cfgM[1]!.trim() });
  const setup = await ws.current('setup.py');
  const setupM = setup && /python_requires\s*=\s*['"]([^'"]+)['"]/.exec(setup);
  if (setupM) decl.push({ source: 'setup.py#python_requires', value: setupM[1]! });
  const tox = await ws.current('tox.ini');
  const toxM = tox && /^\s*envlist\s*=\s*(.+)$/m.exec(tox);
  const toxPy = toxM && [...toxM[1]!.matchAll(/\bpy(3)(\d{1,2})\b/g)].map((m) => Number(m[2]));
  if (toxPy && toxPy.length) decl.push({ source: 'tox.ini#envlist', value: `3.${Math.max(...toxPy)}` });

  return {
    files,
    pyproject,
    pipfile,
    requirements,
    manager,
    lockfile: lock,
    dependencies: deps,
    versionDeclarations: decl,
    buildBackend: str(obj(pyproject?.['build-system'])['build-backend']),
    projectName: str(project.name) ?? str(poetry.name) ?? null,
    description: str(project.description) ?? str(poetry.description) ?? null,
    optionalGroups: Object.keys(optional),
    warnings,
  };
}
