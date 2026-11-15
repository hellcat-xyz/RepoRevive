import type { Workspace } from '../../core/workspace';
import { languageCounts, listWorkflows, walkFiles } from '../shared';
import type { ProjectAnalysis } from '../types';
import { normalizeName, type PythonProject, readPythonProject } from './project';

const FRAMEWORKS: [string, string][] = [
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['fastapi', 'FastAPI'],
  ['pytest', 'pytest'],
  ['tox', 'tox'],
  ['numpy', 'NumPy'],
  ['pandas', 'pandas'],
  ['celery', 'Celery'],
];

const TEST_FILE_RE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/;

export interface PythonTestInfo {
  framework: 'pytest' | 'unittest' | null;
  hasTestFiles: boolean;
}

export function detectTests(project: PythonProject, files: string[]): PythonTestInfo {
  const hasTestFiles = files.some((f) => TEST_FILE_RE.test(f) || /(?:^|\/)tests?\/.+\.py$/.test(f));
  const deps = new Set(project.dependencies.map((d) => d.name));
  const toolPytest = Boolean(
    project.pyproject &&
    JSON.stringify((project.pyproject as Record<string, unknown>).tool ?? {}).includes('"pytest"'),
  );
  const pytestConfigured =
    deps.has('pytest') || project.files.has('pytest.ini') || project.files.has('conftest.py') || toolPytest;
  if (!hasTestFiles) return { framework: pytestConfigured ? 'pytest' : null, hasTestFiles };
  return { framework: pytestConfigured ? 'pytest' : 'unittest', hasTestFiles };
}

export async function analyzePythonProject(ws: Workspace): Promise<ProjectAnalysis> {
  const project = await readPythonProject(ws);
  const files = await walkFiles(ws);
  const tests = detectTests(project, files);
  const names = new Set(project.dependencies.map((d) => d.name));
  const warnings = [...project.warnings];
  if (
    !project.files.has('pyproject.toml') &&
    !project.files.has('setup.py') &&
    !project.requirements.length &&
    !project.files.has('Pipfile')
  )
    warnings.push('No dependency manifest was found; only .python-version/tox.ini style hints exist.');
  if (project.manager !== 'pip' && !project.lockfile)
    warnings.push(`${project.manager} project without a lockfile; versions are resolved fresh.`);
  const frameworks = FRAMEWORKS.filter(([n]) => names.has(normalizeName(n))).map(([, label]) => label);
  if (project.buildBackend) {
    const b = project.buildBackend;
    const label = /setuptools/.test(b)
      ? 'setuptools'
      : /hatch/.test(b)
        ? 'hatchling'
        : /poetry/.test(b)
          ? 'poetry-core'
          : null;
    if (label && !frameworks.includes(label)) frameworks.push(label);
  } else if (project.files.has('setup.py') && !frameworks.includes('setuptools'))
    frameworks.push('setuptools');

  const details: Record<string, string> = {};
  if (project.buildBackend) details['Build backend'] = project.buildBackend;
  const decl = project.versionDeclarations[0];
  if (decl) details['Python requirement'] = `${decl.value} (${decl.source})`;

  return {
    ecosystem: 'python',
    packageManager: project.manager,
    projectName: project.projectName,
    description: project.description,
    dependencies: project.dependencies,
    scripts: {},
    lockfiles: project.lockfile ? [project.lockfile] : [],
    lockfileVersion: null,
    runtimeDeclarations: project.versionDeclarations,
    hasBuild: true,
    hasTests: tests.hasTestFiles,
    testFramework: tests.hasTestFiles ? tests.framework : null,
    frameworks,
    languages: languageCounts(files, ['py', 'pyi', 'cfg', 'toml']),
    fileCount: files.length,
    workflows: await listWorkflows(ws),
    isMonorepo: files.filter((f) => /(?:^|\/)(?:pyproject\.toml|setup\.py)$/.test(f)).length > 1,
    details,
    warnings,
  };
}
