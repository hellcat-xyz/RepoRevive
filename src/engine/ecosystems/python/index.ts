import { createHash } from 'node:crypto';
import type { Issue } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import type { Ecosystem, EcosystemDetection } from '../types';
import { analyzePythonProject } from './analyze';
import { diagnosePythonOutput } from './diagnose';
import { planPython, VENV } from './plan';
import { readPythonProject, REQUIREMENT_FILES } from './project';
import { selectPythonRuntime } from './runtime';
import { pythonStrategies } from './strategies';

const FINGERPRINT_FILES = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  '.python-version',
  'runtime.txt',
  ...REQUIREMENT_FILES,
];

async function localModules(ws: Workspace): Promise<Set<string>> {
  const out = new Set<string>();
  for (const dir of ['', 'src']) {
    for (const e of await ws.list(dir).catch(() => [])) {
      if (
        e.type === 'dir' &&
        /^[A-Za-z_]\w*$/.test(e.name) &&
        !['tests', 'test', 'docs', 'src'].includes(e.name)
      )
        out.add(e.name);
      else if (e.type === 'file' && /^[A-Za-z_]\w*\.py$/.test(e.name)) out.add(e.name.slice(0, -3));
    }
  }
  return out;
}

export async function detectPython(ws: Workspace): Promise<EcosystemDetection | null> {
  const p = await readPythonProject(ws);
  const evidence: string[] = [];
  let confidence = 0;
  const manifest = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'].filter((f) => p.files.has(f));
  const reqs = p.requirements.map((r) => r.file);
  if (manifest.length) {
    evidence.push(...manifest);
    confidence = 0.85;
    // A pyproject.toml that only configures tools (black, ruff) is weak evidence.
    const onlyTools =
      manifest.length === 1 &&
      manifest[0] === 'pyproject.toml' &&
      p.pyproject &&
      !('project' in p.pyproject) &&
      !('build-system' in p.pyproject) &&
      !p.files.has('poetry.lock') &&
      !p.files.has('uv.lock') &&
      !('poetry' in ((p.pyproject.tool as Record<string, unknown> | undefined) ?? {}));
    if (onlyTools) confidence = 0.4;
  }
  if (reqs.length) {
    evidence.push(...reqs);
    confidence = Math.max(confidence, 0.8);
  }
  if (p.lockfile) {
    evidence.push(p.lockfile);
    confidence = Math.max(confidence, 0.95);
  }
  if (confidence === 0) {
    for (const f of ['tox.ini', '.python-version', 'runtime.txt']) if (p.files.has(f)) evidence.push(f);
    if (evidence.length) confidence = 0.35;
  }
  return confidence > 0 ? { confidence, evidence } : null;
}

export const pythonEcosystem: Ecosystem = {
  id: 'python',
  displayName: 'Python',
  language: 'Python',
  family: 'python',
  supportsCiModernize: false,

  async detect(ws) {
    return ((await detectPython(ws))?.confidence ?? 0) >= 0.5;
  },
  detection: detectPython,

  sandboxEnv: () => ({
    PYTHONPYCACHEPREFIX: '/tmp/pycache',
    PYTHONUNBUFFERED: '1',
    POETRY_VIRTUALENVS_CREATE: 'false',
    POETRY_NO_INTERACTION: '1',
    UV_PROJECT_ENVIRONMENT: VENV,
    UV_PYTHON_DOWNLOADS: 'never',
    UV_LINK_MODE: 'copy',
    PIP_NO_INPUT: '1',
    PIPENV_NOSPIN: '1',
  }),

  analyze: analyzePythonProject,

  async selectRuntime(ws) {
    return selectPythonRuntime((await readPythonProject(ws)).versionDeclarations);
  },

  async plan(ws, _runtime, timeouts) {
    return (await planPython(ws, timeouts)).plan;
  },

  async installFingerprint(ws, runtime) {
    const h = createHash('sha256').update(runtime.image);
    for (const f of FINGERPRINT_FILES)
      h.update(`\0${f}\0${(await ws.current(f).catch(() => null)) ?? '<none>'}`);
    return h.digest('hex');
  },

  async diagnose(result, ctx) {
    const project = await readPythonProject(ctx.ws);
    return diagnosePythonOutput({
      result,
      manager: project.manager,
      localModules: await localModules(ctx.ws),
      declared: new Set(project.dependencies.map((d) => d.name)),
    });
  },

  async staticIssues(): Promise<Issue[]> {
    return [];
  },

  warningsFromLogs(output) {
    return [...new Set([...output.matchAll(/DEPRECATION: ([^\n]{5,160})/g)].map((m) => m[1]!.trim()))].slice(
      0,
      10,
    );
  },

  async lockfileRegeneration(ws) {
    const p = await readPythonProject(ws);
    if (!p.lockfile) return null;
    const cmd = { poetry: 'poetry lock', uv: 'uv lock', pipenv: 'pipenv lock', pip: '' }[p.manager];
    if (!cmd) return null;
    const tool = p.manager === 'pipenv' ? 'pipenv' : p.manager;
    return {
      lockfile: p.lockfile,
      command: [
        'sh',
        '-c',
        `export PATH=${VENV}/bin:$PATH VIRTUAL_ENV=${VENV} && [ -x ${VENV}/bin/python ] || python -m venv ${VENV}; python -m pip install --quiet ${tool} && ${cmd}`,
      ],
    };
  },

  strategies: pythonStrategies,
};
