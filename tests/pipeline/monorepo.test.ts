import { applyPatch, parsePatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import { reportToMarkdown } from '@/engine/report';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  makeRepo,
  MemoryReporter,
  readTree,
  simplePackument,
  type World,
  type WorldView,
} from '../helpers/fake-world';

const CONFIG: PipelineConfig = {
  maxAttempts: 6,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const REGISTRY = new FakeRegistry({
  chai: simplePackument('chai', [
    ['4.2.0', '2018-09-26T00:00:00Z'],
    ['4.3.4', '2021-03-01T00:00:00Z'],
    ['5.0.0', '2024-01-01T00:00:00Z'],
  ]),
});

const lockFor = (deps: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    deps: Object.keys(deps)
      .sort()
      .map((k) => `${k}@${deps[k]}`),
  }) + '\n';

const pkg = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify(
    { name, version: '1.0.0', scripts: { build: 'build', test: 'mocha' }, dependencies: deps },
    null,
    2,
  ) + '\n';

/**
 * mern-server: tests need chai (fixable). mern-client: depends on an unpublished package (not fixable).
 */
const world: World = (v: WorldView) => {
  const name = String(v.pkg().name);
  const deps = v.deps();
  if (v.label === 'lockfile')
    return { exitCode: 0, output: 'up to date', writes: { 'package-lock.json': lockFor(deps) } };
  if (v.label === 'install') {
    if (name === 'mern-client' && deps['left-gone'])
      return {
        exitCode: 1,
        output: 'npm error 404 Not Found - GET https://registry.npmjs.org/left-gone - Not found',
      };
    const lock = v.read('package-lock.json');
    if (lock !== null && lock !== lockFor(deps))
      return {
        exitCode: 1,
        output:
          'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
      };
    return { exitCode: 0, output: 'added 10 packages' };
  }
  if (v.label === 'build') return { exitCode: 0, output: 'built' };
  if (v.label === 'test') {
    if (name === 'mern-server' && !deps.chai)
      return {
        exitCode: 1,
        output: "Error: Cannot find module 'chai'\nRequire stack:\n- /workspace/test/index.js",
      };
    return { exitCode: 0, output: '3 passing' };
  }
  return { exitCode: 0, output: '' };
};

async function resurrect(files: Record<string, string>, w: World = world, config = CONFIG) {
  const repo = await makeRepo(files);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const sandbox = new FakeSandbox(w);
  const pipeline = new ResurrectionPipeline(
    { sandbox, registry: REGISTRY, llm: null, sink, reporter, clock: fakeClock() },
    config,
  );
  const outcome = await pipeline.run({
    jobId: 'job-mern',
    repo: { owner: 'ghost', name: 'mern-app', url: 'https://github.com/ghost/mern-app' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'b'.repeat(40), commitDate: '2021-06-01T00:00:00Z' },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, sink, reporter, sandbox, tree };
}

const hasChai = (raw: string) => {
  const j = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Boolean(j.dependencies?.chai ?? j.devDependencies?.chai);
};

const MERN: Record<string, string> = {
  'README.md': '# mern',
  'client/package.json': pkg('mern-client', { 'left-gone': '^1.0.0' }),
  'client/package-lock.json': lockFor({ 'left-gone': '^1.0.0' }),
  'server/package.json': pkg('mern-server', { express: '^4.17.1' }),
  'server/package-lock.json': lockFor({ express: '^4.17.1' }),
};

describe('multi-project (MERN) resurrection', () => {
  it('verifies each sub-project, repairs the fixable one, and labels attempts by project', async () => {
    const { outcome, reporter, sandbox } = await resurrect(MERN);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.report.projects?.map((p) => [p.folder, p.health])).toEqual([
      ['client', 'UNRECOVERABLE'],
      ['server', 'REVIVED'],
    ]);
    expect(outcome.health).toBe('PARTIALLY_REVIVED');

    const verified = outcome.attempts.filter((a) => a.status === 'VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]!.project).toBe('server');
    expect(verified[0]!.files.every((f) => f.startsWith('server/'))).toBe(true);
    expect(outcome.attempts.some((a) => a.project === 'client' && a.status === 'SUGGESTED')).toBe(true);
    expect(outcome.attempts.map((a) => a.seq)).toEqual(outcome.attempts.map((_, i) => i + 1));
    expect(reporter.attempts).toHaveLength(outcome.attempts.length);

    // Each project ran in its own mounted folder (never the repository root).
    expect(new Set(sandbox.runs.map((r) => r.label))).toContain('install');
    expect(outcome.report.warnings.join(' ')).toMatch(/Multi-project/);
  });

  it('follows the state machine phase by phase and ends COMPLETED', async () => {
    const { reporter } = await resurrect(MERN);
    expect(reporter.statuses).toEqual([
      'CLONING',
      'ANALYZING',
      'BASELINE',
      'DIAGNOSING',
      'REPAIRING',
      'VERIFYING',
      'REPORTING',
      'COMPLETED',
    ]);
  });

  it('produces one patch with root-relative paths that applies to the original files', async () => {
    const { outcome } = await resurrect(MERN);
    const patched: Record<string, string> = { ...MERN };
    for (const p of parsePatch(outcome.patch)) {
      const target = (p.newFileName ?? '').replace(/^b\//, '');
      const source = (p.oldFileName ?? '').replace(/^a\//, '');
      const result = applyPatch(p.oldFileName === '/dev/null' ? '' : MERN[source]!, p);
      expect(result).not.toBe(false);
      patched[target] = result as string;
    }
    const touched = parsePatch(outcome.patch).map((p) => (p.newFileName ?? '').replace(/^b\//, ''));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((f) => f.startsWith('server/'))).toBe(true);
    expect(hasChai(patched['server/package.json']!)).toBeTruthy();
    expect(patched['client/package.json']).toBe(MERN['client/package.json']);
  });

  it('leaves the failing project byte-identical and the repaired one with only the kept fix', async () => {
    const { tree } = await resurrect(MERN);
    expect(tree['client/package.json']).toBe(MERN['client/package.json']);
    expect(tree['client/package-lock.json']).toBe(MERN['client/package-lock.json']);
    expect(hasChai(tree['server/package.json']!)).toBeTruthy();
  });

  it('is REVIVED only when every project is revived', async () => {
    const { outcome } = await resurrect({
      ...MERN,
      'client/package.json': pkg('mern-client'),
      'client/package-lock.json': lockFor({}),
    });
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.report.projects?.every((p) => p.health === 'REVIVED')).toBe(true);
  });

  it('keeps going when one project throws, and reports the error on that project only', async () => {
    const throwing: World = (v) => {
      if (String(v.pkg().name) === 'mern-client') throw new Error('sandbox exploded');
      return world(v);
    };
    const { outcome } = await resurrect(MERN, throwing);
    expect(outcome.status).toBe('COMPLETED');
    const client = outcome.report.projects?.find((p) => p.folder === 'client');
    const server = outcome.report.projects?.find((p) => p.folder === 'server');
    expect(client?.error?.code).toBe('INTERNAL');
    expect(server?.health).toBe('REVIVED');
    expect(outcome.health).toBe('PARTIALLY_REVIVED');
  });

  it('reports projects beyond MAX_SUBPROJECTS as not run and never calls the job revived', async () => {
    const files: Record<string, string> = {
      'a/package.json': pkg('a'),
      'a/package-lock.json': lockFor({}),
      'b/package.json': pkg('b'),
      'b/package-lock.json': lockFor({}),
    };
    const { outcome } = await resurrect(files, world, { ...CONFIG, maxProjects: 1 });
    expect(outcome.report.projects?.map((p) => [p.folder, p.health, Boolean(p.notRun)])).toEqual([
      ['a', 'REVIVED', false],
      ['b', 'UNRECOVERABLE', true],
    ]);
    expect(outcome.health).toBe('PARTIALLY_REVIVED');
  });

  it('runs the root project plus a companion client folder', async () => {
    const { outcome } = await resurrect({
      'package.json': pkg('mern-root'),
      'package-lock.json': lockFor({}),
      'client/package.json': pkg('mern-client'),
      'client/package-lock.json': lockFor({}),
    });
    expect(outcome.report.projects?.map((p) => p.folder)).toEqual(['', 'client']);
    expect(outcome.health).toBe('REVIVED');
  });

  it('renders every project in the Markdown report', async () => {
    const { outcome } = await resurrect(MERN);
    const md = reportToMarkdown(outcome.report);
    expect(md).toContain('## Projects');
    expect(md).toContain('| client |');
    expect(md).toContain('| server |');
  });

  it('single-project reports have no projects section', async () => {
    const { outcome } = await resurrect({
      'package.json': pkg('mern-root'),
      'package-lock.json': lockFor({}),
    });
    expect(outcome.report.projects).toBeUndefined();
    expect(reportToMarkdown(outcome.report)).not.toContain('## Projects');
  });
});
