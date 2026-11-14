import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryEventSink, type UpstreamResolver } from '@/engine/core/ports';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import { reportToMarkdown } from '@/engine/report';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  FakeUpstream,
  makeRepo,
  MemoryReporter,
  readTree,
  type World,
} from '../helpers/fake-world';

/**
 * Regression for hellcat-xyz/OrexisAI @ fb7ffcdbbd358a6f7186a65381b6d2837a669f18.
 * `npm ci` fails in the project's own postinstall because a script downloads
 * HyperSpeedPresets.js from DavidHDev/react-bits@main, where the file no longer exists.
 * Before the repair-engine upgrade the failure was classified as "The install step failed"
 * and the repair stage finished without trying anything.
 */
const ORExIS_LOG = readFileSync(path.join(__dirname, '..', 'fixtures', 'orexis-postinstall-404.log'), 'utf8');
const SCRIPT = 'scripts/build-reactbits-hyperspeed.mjs';
const COMMIT_DATE = '2026-09-29T13:32:35Z';
const ERA_SHA = '056aa235d4b5a17aa8ba2b5808554e0f37d2cf27';
const BASE = 'src/content/Backgrounds/Hyperspeed';

const SCRIPT_SOURCE = `import { build } from 'esbuild';
// Official ReactBits JS + CSS implementation used by the linked component page.
const sourceBase = 'https://raw.githubusercontent.com/DavidHDev/react-bits/main/${BASE}';
const sourceFiles = ['Hyperspeed.jsx', 'Hyperspeed.css', 'HyperSpeedPresets.js'];
async function downloadOfficialSource(fileName) {
    const response = await fetch(\`\${sourceBase}/\${fileName}\`);
    if (!response.ok) {
        throw new Error(\`Unable to download official ReactBits \${fileName}: HTTP \${response.status}\`);
    }
    return response.text();
}
`;

const FILES: Record<string, string> = {
  'package.json':
    JSON.stringify(
      {
        name: 'outcomeai-login',
        version: '3.0.0',
        scripts: {
          postinstall: 'npm run build:hyperspeed',
          'build:hyperspeed': `node ${SCRIPT}`,
          build: 'vite build',
          test: 'vitest run',
        },
        dependencies: { esbuild: '^0.21.0' },
      },
      null,
      2,
    ) + '\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  [SCRIPT]: SCRIPT_SOURCE,
};

const CONFIG: PipelineConfig = {
  maxAttempts: 6,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const fullUpstream = () =>
  new FakeUpstream(
    { 'DavidHDev/react-bits@main': ERA_SHA },
    new Set(
      ['Hyperspeed.jsx', 'Hyperspeed.css', 'HyperSpeedPresets.js'].map(
        (f) => `DavidHDev/react-bits@${ERA_SHA}:${BASE}/${f}`,
      ),
    ),
  );

/** The sandbox world: install fails while the script still tracks the moving `main` branch. */
function orexisWorld(opts: { stillBroken?: boolean; buildFails?: boolean } = {}): World {
  return (v) => {
    if (v.label === 'install') {
      const script = v.read(SCRIPT) ?? '';
      if (opts.stillBroken || /react-bits\/main\//.test(script)) return { exitCode: 1, output: ORExIS_LOG };
      return { exitCode: 0, output: 'added 312 packages' };
    }
    if (v.label === 'build')
      return opts.buildFails
        ? { exitCode: 1, output: 'error during build: boom' }
        : { exitCode: 0, output: 'built' };
    return { exitCode: 0, output: '4 passed' };
  };
}

async function run(opts: { upstream: UpstreamResolver | null; world: World; maxAttempts?: number }) {
  const repo = await makeRepo(FILES);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const sandbox = new FakeSandbox(opts.world);
  const pipeline = new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      llm: null,
      upstream: opts.upstream,
      sink,
      reporter,
      clock: fakeClock(),
    },
    { ...CONFIG, maxAttempts: opts.maxAttempts ?? CONFIG.maxAttempts },
  );
  const outcome = await pipeline.run({
    jobId: 'job-orexis',
    repo: { owner: 'hellcat-xyz', name: 'OrexisAI', url: 'https://github.com/hellcat-xyz/OrexisAI' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'fb7ffcdbbd358a6f7186a65381b6d2837a669f18', commitDate: COMMIT_DATE },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  const logs = sink.events.flatMap((e) => (e.type === 'log' ? [`[${e.source}] ${e.message}`] : []));
  return { outcome, sink, reporter, sandbox, tree, logs };
}

describe('OrexisAI regression: postinstall HTTP 404', () => {
  it('diagnoses the specific cause instead of "The install step failed"', async () => {
    const { outcome, logs } = await run({ upstream: fullUpstream(), world: orexisWorld() });
    const cause = outcome.report.rootCauses[0]!;
    expect(cause.kind).toBe('broken-upstream-resource');
    expect(cause.title).toMatch(/postinstall script scripts\/build-reactbits-hyperspeed\.mjs/);
    expect(cause.title).toMatch(/HTTP 404: HyperSpeedPresets\.js/);
    expect(logs.join('\n')).not.toMatch(/The install step failed/);
    expect(
      logs.some(
        (l) => l.startsWith('[diagnose]') && l.includes('file=scripts/build-reactbits-hyperspeed.mjs'),
      ),
    ).toBe(true);
  });

  it('attempts a real repair, verifies it in the sandbox, and keeps only that change', async () => {
    const { outcome, tree, sandbox, logs } = await run({ upstream: fullUpstream(), world: orexisWorld() });

    expect(outcome.health).toBe('REVIVED');
    const verified = outcome.attempts.filter((a) => a.status === 'VERIFIED');
    expect(verified.map((a) => a.strategyId)).toEqual(['upstream-ref-pin']);
    expect(verified[0]!.verification?.steps.install.status).toBe('passed');
    expect(verified[0]!.files).toEqual([SCRIPT]);

    // Only the ref segment changed; nothing else in the script or repo.
    expect(tree[SCRIPT]).toBe(SCRIPT_SOURCE.replace('/react-bits/main/', `/react-bits/${ERA_SHA}/`));
    expect(tree['package.json']).toBe(FILES['package.json']);
    expect(outcome.patch).toContain(`+++ b/${SCRIPT}`);
    expect(outcome.patch).toContain(ERA_SHA);
    expect(outcome.patch.match(/^\+\+\+ /gm)).toHaveLength(1);

    // Candidate was applied and the install was actually re-run (baseline + candidate + clean final).
    expect(sandbox.runs.filter((r) => r.label === 'install').length).toBeGreaterThanOrEqual(3);
    for (const needle of [
      '[diagnose] Found:',
      '[repair] Investigating:',
      '[patch] Candidate patch applied',
      '[verify] Re-running install',
      '[repair] Fix verified and kept',
      '[report] Resurrection report generated',
    ])
      expect(logs.some((l) => l.startsWith(needle) || l.includes(needle))).toBe(true);

    const md = reportToMarkdown(outcome.report);
    expect(md).toContain('Pin upstream download URLs');
    expect(md).toContain('`VERIFIED`');
  });

  it('records the repair stage in the report with the era commit it pinned to', async () => {
    const up = fullUpstream();
    const { outcome } = await run({ upstream: up, world: orexisWorld() });
    expect(up.calls).toContain(`commitAt DavidHDev/react-bits@main <= ${COMMIT_DATE}`);
    expect(up.calls).toContain(`fileExists DavidHDev/react-bits@${ERA_SHA}:${BASE}/HyperSpeedPresets.js`);
    expect(outcome.attempts[0]!.rationale).toMatch(/2026-09-29/);
  });

  it('never fabricates a fix: if the file is missing upstream at that commit, it proposes nothing', async () => {
    const up = new FakeUpstream({ 'DavidHDev/react-bits@main': ERA_SHA }, new Set());
    const { outcome, tree, logs } = await run({ upstream: up, world: orexisWorld() });
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.patch).toBe('');
    expect(tree[SCRIPT]).toBe(SCRIPT_SOURCE);
    expect(outcome.attempts.map((a) => a.status)).toEqual(['SUGGESTED']);
    expect(outcome.attempts[0]!.issueKind).toBe('broken-upstream-resource');
    expect(logs.some((l) => /\[repair\] No safe fix found .*upstream-ref-pin/.test(l))).toBe(true);
  });

  it('is never silent without an upstream resolver: it explains and records a suggestion', async () => {
    const { outcome, logs } = await run({ upstream: null, world: orexisWorld() });
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ status: 'SUGGESTED', issueKind: 'broken-upstream-resource' });
    expect(logs.some((l) => l.startsWith('[repair] No safe fix found'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[repair] Repair stage finished:'))).toBe(true);
  });

  it('reverts a candidate that does not fix the install and leaves the workspace untouched', async () => {
    const { outcome, tree } = await run({
      upstream: fullUpstream(),
      world: orexisWorld({ stillBroken: true }),
    });
    expect(outcome.attempts.map((a) => a.status)).toEqual(['REVERTED', 'SUGGESTED']);
    expect(outcome.attempts[0]!.strategyId).toBe('upstream-ref-pin');
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.patch).toBe('');
    expect(tree).toEqual(FILES);
  });

  it('keeps the verified install fix but does not call the repo revived while the build still fails', async () => {
    const { outcome } = await run({ upstream: fullUpstream(), world: orexisWorld({ buildFails: true }) });
    expect(outcome.attempts.find((a) => a.status === 'VERIFIED')?.strategyId).toBe('upstream-ref-pin');
    expect(outcome.health).toBe('PARTIALLY_REVIVED');
    expect(outcome.report.verification.final?.steps.build.status).toBe('failed');
    expect(outcome.report.remainingIssues.map((i) => i.kind)).toContain('build-failure');
  });
});
