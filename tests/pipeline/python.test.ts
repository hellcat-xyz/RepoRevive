import { describe, expect, it } from 'vitest';
import { computeCoverage } from '@/engine/core/coverage';
import { MemoryEventSink } from '@/engine/core/ports';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems, ECOSYSTEMS } from '@/engine/ecosystems';
import { analyzePythonProject } from '@/engine/ecosystems/python/analyze';
import { diagnosePythonOutput } from '@/engine/ecosystems/python/diagnose';
import { readPythonProject } from '@/engine/ecosystems/python/project';
import {
  eraPythonMinor,
  resolvePythonDeclaration,
  selectPythonRuntime,
} from '@/engine/ecosystems/python/runtime';
import { rewriteCollectionsAbc } from '@/engine/ecosystems/python/strategies';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  makeRepo,
  MemoryReporter,
  readTree,
  simplePackument,
  type World,
} from '../helpers/fake-world';
import { PY_FIXTURES } from '../fixtures/projects/python';

const CONFIG: PipelineConfig = {
  maxAttempts: 8,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const PYPI = new FakeRegistry({
  requests: simplePackument('requests', [
    ['2.25.1', '2020-12-16T00:00:00Z'],
    ['2.26.0', '2021-07-13T00:00:00Z'],
    ['2.31.0', '2023-05-22T00:00:00Z'],
  ]),
});

async function resurrect(fx: { files: Record<string, string>; commitDate: string }, world: World) {
  const repo = await makeRepo(fx.files);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const sandbox = new FakeSandbox(world);
  const pipeline = new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      registries: { python: PYPI },
      llm: null,
      sink,
      reporter,
      clock: fakeClock(),
    },
    CONFIG,
  );
  const outcome = await pipeline.run({
    jobId: 'job-py',
    repo: { owner: 'ghost', name: 'py', url: 'https://github.com/ghost/py' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'b'.repeat(40), commitDate: fx.commitDate },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, sandbox, tree, sink, reporter };
}

const ok = { exitCode: 0, output: 'ok' };

describe('python runtime selection', () => {
  it('maps declarations to supported minors without Node-style majors', () => {
    expect(resolvePythonDeclaration('3.9.7')?.minor).toBe(9);
    expect(resolvePythonDeclaration('>=3.8,<3.11')?.minor).toBe(10);
    expect(resolvePythonDeclaration('^3.8')?.minor).toBe(12);
    expect(resolvePythonDeclaration('~=3.8.1')?.minor).toBe(8);
    expect(resolvePythonDeclaration('python-3.7.4')?.minor).toBe(7);
    expect(resolvePythonDeclaration('3.5')).toMatchObject({ minor: 7 });
    expect(resolvePythonDeclaration('banana')).toBeNull();
    const r = selectPythonRuntime([{ source: 'x', value: '3.9' }]);
    expect(r).toMatchObject({ family: 'python', image: 'python:3.9-slim', version: '3.9', major: 3 });
    expect(selectPythonRuntime([]).image).toBe('python:3.11-slim');
  });
  it('infers the era interpreter from a commit date', () => {
    expect(eraPythonMinor('2019-06-01')).toBe(7);
    expect(eraPythonMinor('2021-01-01')).toBe(9);
    expect(eraPythonMinor('2030-01-01')).toBe(12);
    expect(eraPythonMinor(null)).toBe(11);
  });
});

describe('python detection and analysis', () => {
  it('detects package managers from lockfiles and metadata', async () => {
    const poetry = await makeRepo(PY_FIXTURES.lockfileInconsistency.files);
    const ws = await Workspace.open(poetry.repoDir);
    expect((await readPythonProject(ws)).manager).toBe('poetry');
    const a = await analyzePythonProject(ws);
    expect(a).toMatchObject({ ecosystem: 'python', packageManager: 'poetry' });
    expect(a.dependencies.map((d) => d.name)).toEqual(expect.arrayContaining(['requests', 'click']));
    expect(a.details?.['Build backend']).toBe('poetry.core.masonry.api');
    const det = await detectEcosystems(ws, ECOSYSTEMS);
    expect(det.selected?.ecosystem.id).toBe('python');
    await poetry.cleanup();
  });

  it('exposes ambiguity when a Node project also has Python metadata', async () => {
    const repo = await makeRepo({
      'package.json': '{"name":"x","scripts":{"build":"tsc"}}',
      'requirements.txt': 'mkdocs==1.5.0\n',
    });
    const det = await detectEcosystems(await Workspace.open(repo.repoDir), ECOSYSTEMS);
    expect(det.selected?.ecosystem.id).toBe('npm');
    expect(det.ambiguous).toBe(true);
    await repo.cleanup();
  });

  it('does not treat a tool-only pyproject as a Python project', async () => {
    const repo = await makeRepo({
      'pyproject.toml': '[tool.black]\nline-length = 100\n',
      'package.json': '{"name":"x"}',
    });
    const det = await detectEcosystems(await Workspace.open(repo.repoDir), ECOSYSTEMS);
    expect(det.selected?.ecosystem.id).toBe('npm');
    expect(det.ambiguous).toBe(false);
    await repo.cleanup();
  });
});

describe('python diagnosis', () => {
  const base = { manager: 'pip', localModules: new Set(['mypkg']), declared: new Set<string>() };
  const diag = (step: 'install' | 'build' | 'test', logTail: string) =>
    diagnosePythonOutput({ ...base, result: { step, status: 'failed', logTail } });
  it('classifies the common failures', () => {
    expect(diag('install', 'ERROR: No matching distribution found for requests==2.0.99')[0]).toMatchObject({
      kind: 'missing-version',
      data: { package: 'requests', version: '2.0.99' },
    });
    expect(
      diag('install', "ERROR: Package 'foo' requires a different Python: 3.12.1 not in '>=3.6,<3.9'")[0]
        ?.kind,
    ).toBe('toolchain-mismatch');
    expect(diag('install', 'ERROR: ResolutionImpossible: for help visit')[0]?.kind).toBe(
      'dependency-conflict',
    );
    expect(
      diag(
        'install',
        'pyproject.toml changed significantly since poetry.lock was last generated. Run `poetry lock`',
      )[0]?.kind,
    ).toBe('lockfile-drift');
    expect(diag('test', "ModuleNotFoundError: No module named 'mypkg.core'")[0]?.kind).toBe('import-path');
    expect(diag('test', "ModuleNotFoundError: No module named 'yaml'")[0]).toMatchObject({
      kind: 'missing-module',
      data: { module: 'yaml' },
    });
    expect(diag('install', "ModuleNotFoundError: No module named 'distutils'")[0]?.kind).toBe(
      'removed-stdlib-api',
    );
    expect(
      diag(
        'build',
        '  File "/workspace/a.py", line 3\n    print "x"\nSyntaxError: Missing parentheses in call to \'print\'',
      )[0],
    ).toMatchObject({ kind: 'legacy-syntax' });
    expect(diag('test', 'FAILED tests/test_a.py::t - assert 1 == 2')[0]?.kind).toBe('test-failure');
  });
});

describe('collections.abc rewrite', () => {
  it('rewrites imports and attribute uses, and is a no-op otherwise', () => {
    expect(rewriteCollectionsAbc('from collections import OrderedDict, Mapping\n')).toBe(
      'from collections import OrderedDict\nfrom collections.abc import Mapping\n',
    );
    expect(rewriteCollectionsAbc('import collections\nx = collections.Mapping\n')).toBe(
      'import collections\nimport collections.abc\nx = collections.abc.Mapping\n',
    );
    expect(rewriteCollectionsAbc('from collections import OrderedDict\n')).toBeNull();
  });
});

describe('python pipeline fixtures (scripted sandbox)', () => {
  it('repins an unavailable version to an era release and touches only requirements.txt', async () => {
    const fx = PY_FIXTURES.dependencyFailure;
    const r = await resurrect(fx, (v) => {
      if (v.label === 'install') {
        const req = v.read('requirements.txt') ?? '';
        return /requests==2\.0\.99/.test(req)
          ? {
              exitCode: 1,
              output:
                'ERROR: Could not find a version that satisfies the requirement requests==2.0.99 (from versions: 2.25.1)\nERROR: No matching distribution found for requests==2.0.99',
            }
          : ok;
      }
      return ok;
    });
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.report.ecosystem).toBe('python');
    expect(r.outcome.report.analysis?.packageManager).toBe('pip');
    expect(r.tree['requirements.txt']).toBe('requests==2.25.1\nflask==2.0.1\n');
    expect(r.outcome.workspace?.changes().map((c) => c.path)).toEqual(['requirements.txt']);
    const kept = r.outcome.attempts.filter((a) => a.status === 'VERIFIED');
    expect(kept.map((a) => a.strategyId)).toEqual(['python-repin-version']);
    expect(r.outcome.report.coverage?.level).toBe('full');
    // Every command ran in an approved Python image and used the venv, never npm.
    for (const run of r.sandbox.runs) {
      expect(run.image).toBe('python:3.11-slim');
      expect(run.command.join(' ')).not.toMatch(/\bnpm\b/);
    }
  });

  it('pins the era Python for a removed-stdlib failure', async () => {
    const fx = PY_FIXTURES.runtimeMismatch;
    const r = await resurrect(fx, (v) => {
      if (v.label === 'test' && v.command.join(' ').includes('pytest')) {
        const modern = v.read('.python-version') === null;
        return modern
          ? {
              exitCode: 1,
              output:
                "ImportError: cannot import name 'Mapping' from 'collections' (/usr/local/lib/python3.11/collections/__init__.py)\n  File \"/workspace/legacy.py\", line 1, in <module>",
            }
          : ok;
      }
      return ok;
    });
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace?.changes()).toMatchObject([{ path: '.python-version', after: '3.7\n' }]);
    expect(r.outcome.workspace?.changes().map((c) => c.path)).toEqual(['.python-version']);
    expect(r.outcome.attempts.find((a) => a.status === 'VERIFIED')?.strategyId).toBe('python-pin-runtime');
    expect(r.sandbox.runs.some((x) => x.image === 'python:3.7-slim')).toBe(true);
  });

  it('regenerates a stale poetry lock through the sandbox', async () => {
    const fx = PY_FIXTURES.lockfileInconsistency;
    const r = await resurrect(fx, (v) => {
      if (v.label === 'lockfile')
        return { exitCode: 0, output: 'Writing lock file', writes: { 'poetry.lock': '# fresh lock\n' } };
      if (v.label === 'install') {
        return (v.read('poetry.lock') ?? '').includes('stale')
          ? {
              exitCode: 1,
              output:
                'pyproject.toml changed significantly since poetry.lock was last generated. Run `poetry lock` to fix the lock file.',
            }
          : ok;
      }
      return ok;
    });
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.tree['poetry.lock']).toBe('# fresh lock\n');
    expect(r.outcome.workspace?.changes().map((c) => c.path)).toEqual(['poetry.lock']);
    expect(r.sandbox.runs.find((x) => x.label === 'install')?.command.join(' ')).toContain('poetry install');
  });

  it('reports a project without tests as build-only, never fully verified', async () => {
    const r = await resurrect(PY_FIXTURES.noTests, () => ok);
    expect(r.outcome.report.verification.final?.steps.test).toMatchObject({
      status: 'skipped',
      skipReason: 'no-test-suite',
    });
    expect(r.outcome.report.coverage?.level).toBe('build-only');
    expect(r.outcome.report.coverage?.testedFunctionally).toBe(false);
    expect(computeCoverage(r.outcome.report.verification.final as never).level).toBe('build-only');
  });

  it('never applies Node strategies or commands to a Python project', async () => {
    const r = await resurrect(PY_FIXTURES.dependencyFailure, () => ({
      exitCode: 1,
      output: "npm ERR! code ERESOLVE\nCannot find module 'lodash'",
    }));
    for (const a of r.outcome.attempts) expect(a.strategyId).not.toMatch(/^(npm|node)-|legacy-peer/);
    for (const run of r.sandbox.runs) expect(run.image.startsWith('node:')).toBe(false);
  });
});
