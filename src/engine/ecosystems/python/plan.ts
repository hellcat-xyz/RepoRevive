import { shellSafe } from '../../core/command';
import type { StepName } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import { walkFiles } from '../shared';
import type { StepPlan } from '../types';
import { detectTests } from './analyze';
import { type PythonProject, readPythonProject } from './project';

export const VENV = '/cache/venv';
const ENV_PREFIX = `export PATH=${VENV}/bin:$PATH VIRTUAL_ENV=${VENV}`;

/** Fixed `sh -c` template: venv bootstrap shared by every package manager. */
function bootstrap(): string[] {
  return [
    `${ENV_PREFIX}`,
    `[ -x ${VENV}/bin/python ] || python -m venv ${VENV}`,
    'python -m pip install --quiet --disable-pip-version-check setuptools wheel',
  ];
}

export function installScript(project: PythonProject, needsPytest: boolean): string {
  const lines = bootstrap();
  switch (project.manager) {
    case 'poetry':
      lines.push('python -m pip install --quiet poetry', 'poetry install --no-interaction --no-ansi');
      break;
    case 'uv':
      lines.push(
        'python -m pip install --quiet uv',
        project.lockfile ? 'uv sync --locked --all-extras' : 'uv sync --all-extras',
      );
      break;
    case 'pipenv':
      lines.push(
        'python -m pip install --quiet pipenv',
        project.lockfile ? 'pipenv install --dev --system --deploy' : 'pipenv install --dev --system',
      );
      break;
    case 'pip': {
      for (const r of project.requirements) lines.push(`python -m pip install -r ${shellSafe(r.file)}`);
      const buildable = ['pyproject.toml', 'setup.py', 'setup.cfg'].some((f) => project.files.has(f));
      if (buildable) {
        const extras = project.optionalGroups.filter((g) => /^(?:dev|test|tests|testing)$/.test(g));
        lines.push(
          extras.length
            ? `python -m pip install -e ".[${extras.map(shellSafe).join(',')}]"`
            : 'python -m pip install -e .',
        );
      }
      break;
    }
  }
  if (needsPytest) lines.push('python -m pip install --quiet pytest');
  return lines.join(' && ');
}

export async function planPython(
  ws: Workspace,
  timeouts: Record<StepName, number>,
): Promise<{ plan: StepPlan[]; project: PythonProject }> {
  const project = await readPythonProject(ws);
  const files = await walkFiles(ws);
  const tests = detectTests(project, files);
  const needsPytest =
    tests.framework === 'pytest' &&
    !project.dependencies.some((d) => d.name === 'pytest') &&
    project.manager === 'pip';
  const install: StepPlan = {
    step: 'install',
    command: ['sh', '-c', installScript(project, needsPytest)],
    network: 'bridge',
    timeoutMs: timeouts.install,
  };
  const hasPython = files.some((f) => f.endsWith('.py'));
  const build: StepPlan = hasPython
    ? {
        step: 'build',
        command: [
          'sh',
          '-c',
          `${ENV_PREFIX} && python -m compileall -q -x '(^|/)(\\.venv|venv|node_modules|\\.git|build|dist|docs?)(/|$)' .`,
        ],
        network: 'none',
        timeoutMs: timeouts.build,
      }
    : { step: 'build', command: null, skipReason: 'not-applicable', network: 'none', timeoutMs: 0 };
  let test: StepPlan;
  if (!tests.hasTestFiles) {
    test = { step: 'test', command: null, skipReason: 'no-test-suite', network: 'none', timeoutMs: 0 };
  } else if (tests.framework === 'pytest') {
    test = {
      step: 'test',
      command: ['sh', '-c', `${ENV_PREFIX} && python -m pytest -q -p no:cacheprovider`],
      network: 'none',
      timeoutMs: timeouts.test,
    };
  } else {
    test = {
      step: 'test',
      command: ['sh', '-c', `${ENV_PREFIX} && python -m unittest discover`],
      network: 'none',
      timeoutMs: timeouts.test,
    };
  }
  return { plan: [install, build, test], project };
}
