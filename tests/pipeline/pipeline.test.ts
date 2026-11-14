import { applyPatch, parsePatch } from 'diff';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

const fixture = (f: string) => readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');
const LOGS = {
  nodeSass: fixture('node-sass-gyp.log'),
  eresolve: fixture('eresolve.log'),
  openssl: fixture('openssl-webpack4.log'),
  chai: "Error: Cannot find module 'chai'\nRequire stack:\n- /workspace/test/index.js",
  modern:
    "/workspace/node_modules/fancy/index.js:2\n  return a ?? b;\n           ^\nSyntaxError: Unexpected token '?'",
  drift:
    'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
  unpublished: 'npm error 404 Not Found - GET https://registry.npmjs.org/left-gone - Not found',
};

const CONFIG: PipelineConfig = {
  maxAttempts: 10,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const REGISTRY = new FakeRegistry({
  sass: simplePackument('sass', [
    ['1.32.0', '2021-01-01T00:00:00Z'],
    ['1.34.1', '2021-05-25T00:00:00Z'],
    ['1.60.0', '2023-03-01T00:00:00Z'],
  ]),
  chai: simplePackument('chai', [
    ['4.2.0', '2018-09-26T00:00:00Z'],
    ['4.3.4', '2021-03-01T00:00:00Z'],
    ['5.0.0', '2024-01-01T00:00:00Z'],
  ]),
});

const lockFor = (deps: Record<string, string>) =>
  JSON.stringify(
    {
      lockfileVersion: 3,
      deps: Object.keys(deps)
        .sort()
        .map((k) => `${k}@${deps[k]}`),
    },
    null,
    2,
  ) + '\n';

/** Builds a world from independent failure causes. */
function world(opts: {
  peer?: boolean;
  nodeSass?: 'old-node-only' | 'never';
  openssl?: boolean;
  chai?: boolean;
  modernTests?: boolean;
  unpublished?: boolean;
}): World {
  return (v: WorldView) => {
    const deps = v.deps();
    if (v.label === 'lockfile')
      return { exitCode: 0, output: 'up to date', writes: { 'package-lock.json': lockFor(deps) } };
    if (v.label === 'install') {
      const lock = v.read('package-lock.json');
      if (lock !== null && lock !== lockFor(deps)) return { exitCode: 1, output: LOGS.drift };
      if (opts.unpublished) return { exitCode: 1, output: LOGS.unpublished };
      if (opts.peer && !/legacy-peer-deps=true/.test(v.read('.npmrc') ?? ''))
        return { exitCode: 1, output: LOGS.eresolve };
      if (deps['node-sass'] && opts.nodeSass === 'never') return { exitCode: 1, output: LOGS.nodeSass };
      if (deps['node-sass'] && opts.nodeSass === 'old-node-only' && v.major > 14)
        return { exitCode: 1, output: LOGS.nodeSass };
      return {
        exitCode: 0,
        output: 'added 120 packages in 3s\nnpm warn deprecated request@2.88.2: request has been deprecated',
      };
    }
    if (v.label === 'build') {
      if (opts.openssl && v.major > 16) return { exitCode: 1, output: LOGS.openssl };
      return { exitCode: 0, output: 'webpack compiled successfully' };
    }
    if (v.label === 'test') {
      if (opts.chai && !deps.chai) return { exitCode: 1, output: LOGS.chai };
      if (opts.modernTests && v.major < 16) return { exitCode: 1, output: LOGS.modern };
      return { exitCode: 0, output: '12 passing' };
    }
    return { exitCode: 0, output: '' };
  };
}

const pkgJson = (
  deps: Record<string, string>,
  devDeps: Record<string, string> = {},
  scripts = { build: 'webpack', test: 'mocha' },
) =>
  JSON.stringify(
    { name: 'dead-project', version: '1.0.0', scripts, dependencies: deps, devDependencies: devDeps },
    null,
    2,
  ) + '\n';

async function resurrect(files: Record<string, string>, w: World, commitDate = '2020-03-01T00:00:00Z') {
  const repo = await makeRepo(files);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const sandbox = new FakeSandbox(w);
  const pipeline = new ResurrectionPipeline(
    { sandbox, registry: REGISTRY, llm: null, sink, reporter, clock: fakeClock() },
    CONFIG,
  );
  const outcome = await pipeline.run({
    jobId: 'job-test',
    repo: { owner: 'ghost', name: 'dead-project', url: 'https://github.com/ghost/dead-project' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'a'.repeat(40), commitDate },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, sink, reporter, sandbox, tree };
}

/** Apply every verified attempt diff, in order, to the original files (preservation check). */
function replayVerified(
  original: Record<string, string>,
  attempts: { status: string; diff?: string }[],
): Record<string, string> {
  const files: Record<string, string> = { ...original };
  for (const a of attempts) {
    if ((a.status !== 'VERIFIED' && a.status !== 'VERIFIED_STATIC') || !a.diff) continue;
    for (const p of parsePatch(a.diff)) {
      const target = (p.newFileName ?? '').replace(/^b\//, '');
      const source = (p.oldFileName ?? '').replace(/^a\//, '');
      if (p.newFileName === '/dev/null') {
        delete files[source];
        continue;
      }
      const before = p.oldFileName === '/dev/null' ? '' : files[source]!;
      const after = applyPatch(before, p);
      if (after === false) throw new Error(`patch for ${target} did not apply`);
      files[target] = after;
    }
  }
  return files;
}

describe('ResurrectionPipeline (FakeSandbox world model)', () => {
  it('revives a node-sass project by pinning an era-appropriate Node version', async () => {
    const files = { 'package.json': pkgJson({ 'node-sass': '^4.14.1', webpack: '^4.0.0' }) };
    const { outcome, reporter } = await resurrect(files, world({ nodeSass: 'old-node-only' }));
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.health).toBe('REVIVED');
    const verified = outcome.attempts.filter((a) => a.status === 'VERIFIED');
    expect(verified.map((a) => a.title)).toEqual(['Pin Node.js 14 via .nvmrc']);
    expect(outcome.patch).toContain('+++ b/.nvmrc');
    expect(outcome.report.verification.baseline?.steps.install.status).toBe('failed');
    expect(outcome.report.verification.final?.steps.test.status).toBe('passed');
    expect(outcome.report.runtime).toEqual({ baseline: 'node:22', final: 'node:14' });
    expect(reporter.statuses[0]).toBe('CLONING');
    expect(reporter.statuses.at(-1)).toBe('COMPLETED');
    expect(outcome.report.recommendations.join(' ')).toMatch(/end-of-life/);
  });

  it('reverts fixes that do not help and keeps the one that does', async () => {
    const files = { 'package.json': pkgJson({ 'node-sass': '^4.14.1' }) };
    const { outcome, tree } = await resurrect(files, world({ nodeSass: 'never' }));
    expect(outcome.health).toBe('REVIVED');
    const byStatus = (s: string) => outcome.attempts.filter((a) => a.status === s).map((a) => a.strategyId);
    expect(byStatus('REVERTED')).toContain('node-pin');
    expect(byStatus('VERIFIED')).toEqual(['replace-node-sass']);
    expect(tree['.nvmrc']).toBeUndefined();
    expect(JSON.parse(tree['package.json']!).dependencies).toEqual({ sass: '^1.34.1' });
    expect(outcome.patch).not.toContain('.nvmrc');
    expect(outcome.report.dependencyChanges).toEqual([
      { name: 'node-sass', section: 'dependencies', from: '^4.14.1', to: null, change: 'removed' },
      { name: 'sass', section: 'dependencies', from: null, to: '^1.34.1', change: 'added' },
    ]);
  });

  it('chains fixes: peer conflict, then a missing test dependency with lockfile regeneration', async () => {
    const deps = { react: '^17.0.1' };
    const files = {
      'package.json': pkgJson(deps, { mocha: '^8.0.0' }),
      'package-lock.json': lockFor({ ...deps, mocha: '^8.0.0' }),
    };
    const { outcome, tree, sandbox } = await resurrect(files, world({ peer: true, chai: true }));
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.attempts.filter((a) => a.status === 'VERIFIED').map((a) => a.strategyId)).toEqual([
      'npmrc-legacy-peer-deps',
      'add-missing-dependency',
    ]);
    expect(tree['.npmrc']).toBe('legacy-peer-deps=true\n');
    expect(JSON.parse(tree['package.json']!).devDependencies.chai).toBe('^4.2.0'); // era-matched (2020 commit)
    expect(tree['package-lock.json']).toContain('chai@^4.2.0');
    expect(sandbox.runs.some((r) => r.label === 'lockfile' && r.command.includes('--ignore-scripts'))).toBe(
      true,
    );
    // build and test never get network
    expect(
      sandbox.runs
        .filter((r) => r.label === 'build' || r.label === 'test')
        .every((r) => r.network === 'none'),
    ).toBe(true);
  });

  it('reports a healthy repository as never dead and only modernizes CI statically', async () => {
    const wf =
      'on: push\njobs:\n  t:\n    runs-on: ubuntu-18.04\n    steps:\n      - uses: actions/checkout@v2\n';
    const files = { 'package.json': pkgJson({}), '.github/workflows/ci.yml': wf };
    const { outcome } = await resurrect(files, world({}));
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.report.headline).toMatch(/never dead/);
    expect(outcome.attempts.map((a) => a.status)).toEqual(['VERIFIED_STATIC']);
    expect(outcome.patch).toContain('+    runs-on: ubuntu-latest');
    expect(outcome.patch).not.toContain('package.json');
  });

  it('finds a Node version that satisfies conflicting build and test constraints', async () => {
    const files = { 'package.json': pkgJson({ webpack: '^4.0.0' }, {}, { build: 'webpack', test: 'mocha' }) };
    // build needs Node <= 16; tests need Node >= 16 -> Node 16 satisfies both.
    const { outcome } = await resurrect(files, world({ openssl: true, modernTests: true }));
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.report.runtime.final).toBe('node:16');
  });

  it('marks unpublished dependencies as suggestions and the repo as unrecoverable', async () => {
    const { outcome } = await resurrect(
      { 'package.json': pkgJson({ 'left-gone': '1.0.0' }) },
      world({ unpublished: true }),
    );
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.attempts.map((a) => a.status)).toEqual(['SUGGESTED']);
    expect(outcome.patch).toBe('');
    expect(reportToMarkdown(outcome.report)).toContain('no longer available on the npm registry');
  });

  it('completes as unrecoverable for non-Node repositories', async () => {
    const { outcome, reporter } = await resurrect({ 'README.md': '# not node' }, world({}));
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.report.error?.code).toBe('NOT_A_NODE_PROJECT');
    expect(reporter.statuses).toEqual(['CLONING', 'ANALYZING', 'REPORTING', 'COMPLETED']);
  });

  it('emits a done event and heartbeat progression', async () => {
    const { sink } = await resurrect(
      { 'package.json': pkgJson({ 'node-sass': '^4.14.1' }) },
      world({ nodeSass: 'old-node-only' }),
    );
    const beats = sink.events
      .filter((e) => e.type === 'heartbeat')
      .map((e) => (e.type === 'heartbeat' ? e.value : 0));
    expect(beats[0]).toBe(0);
    expect(beats.at(-1)).toBe(100);
    expect(sink.events.at(-1)?.type).toBe('done');
  });

  it('P5: verified fixes are preserved, reverted fixes leave no trace, and progress never regresses', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          peer: fc.boolean(),
          nodeSass: fc.constantFrom(undefined, 'old-node-only' as const, 'never' as const),
          openssl: fc.boolean(),
          chai: fc.boolean(),
          modernTests: fc.boolean(),
          lockfile: fc.boolean(),
          commitYear: fc.integer({ min: 2016, max: 2023 }),
        }),
        async (o) => {
          const deps: Record<string, string> = {
            react: '^17.0.1',
            ...(o.nodeSass ? { 'node-sass': '^4.14.1' } : {}),
          };
          const files: Record<string, string> = { 'package.json': pkgJson(deps, { mocha: '^8.0.0' }) };
          if (o.lockfile) files['package-lock.json'] = lockFor({ ...deps, mocha: '^8.0.0' });
          const { outcome, tree } = await resurrect(files, world(o), `${o.commitYear}-06-01T00:00:00Z`);

          // Preservation + patch consistency: originals + verified diffs (in order) == final tree.
          expect(replayVerified(files, outcome.attempts)).toEqual(tree);

          // Applying the whole patch to the originals also yields the final tree.
          expect(replayVerified(files, [{ status: 'VERIFIED', diff: outcome.patch }])).toEqual(tree);

          // Monotonic progress: each verified runtime fix scores at least as high as the last.
          let score = outcome.report.verification.baseline?.score ?? 0;
          for (const a of outcome.attempts.filter((x) => x.status === 'VERIFIED')) {
            expect(a.verification!.score).toBeGreaterThanOrEqual(score);
            score = a.verification!.score;
          }
          // Health agrees with the final verification.
          const finalScore = outcome.report.verification.final?.score ?? 0;
          if (outcome.health === 'REVIVED') expect(finalScore).toBe(100);
          if (finalScore === 100) expect(outcome.health).toBe('REVIVED');
          expect(finalScore).toBeGreaterThanOrEqual(outcome.report.verification.baseline?.score ?? 0);
        },
      ),
      { numRuns: 30 },
    );
  }, 120_000);
});
