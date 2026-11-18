import { applyPatch, parsePatch } from 'diff';
import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmFixRequest } from '@/engine/core/ports';
import { MemoryEventSink } from '@/engine/core/ports';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import { buildPrBody } from '@/engine/publish/body';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  makeRepo,
  MemoryReporter,
  readTree,
  type World,
  type WorldView,
} from '../helpers/fake-world';

const CONFIG: PipelineConfig = {
  maxAttempts: 8,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const FILES: Record<string, string> = {
  'package.json':
    JSON.stringify(
      { name: 'calc', version: '1.0.0', scripts: { build: 'tsc --noEmit', test: 'mocha' }, dependencies: {} },
      null,
      2,
    ) + '\n',
  'package-lock.json': JSON.stringify({ lockfileVersion: 3, deps: [] }, null, 2) + '\n',
  'src/math.js': 'exports.add = (a, b) => a - b;\n',
  'src/index.js': "const { add } = require('./math');\nconsole.log(add(2, 3));\n",
  'test/math.test.js':
    "const { add } = require('../src/math');\nit('adds', () => { if (add(2, 3) !== 5) throw new Error('bad'); });\n",
};

/** The test passes only when src/math.js really adds. Other bodies fail with their own log. */
const world: World = (v: WorldView) => {
  if (v.label === 'lockfile') return { exitCode: 0, output: 'ok', writes: {} };
  if (v.label === 'install') return { exitCode: 0, output: 'added 0 packages' };
  if (v.label === 'build') return { exitCode: 0, output: 'ok' };
  if (v.label === 'test') {
    const src = v.read('src/math.js') ?? '';
    if (/a \+ b/.test(src)) return { exitCode: 0, output: '1 passing' };
    const got = /a \* b/.test(src) ? 6 : -1;
    return {
      exitCode: 1,
      output: `AssertionError: expected ${got} to equal 5\n    at add (/workspace/src/math.js:1:30)\n    at Context.<anonymous> (/workspace/test/math.test.js:2:40)\nnpm error Test failed.  See above for more details.`,
    };
  }
  return { exitCode: 0, output: '' };
};

type Reply = { rationale: string; edits: { path: string; search: string; replace: string }[] };
const fixAdd = (rationale = 'add() subtracts instead of adding.'): Reply => ({
  rationale,
  edits: [{ path: 'src/math.js', search: 'a - b', replace: 'a + b' }],
});
const wrong = (op: string, rationale = `Try ${op}.`): Reply => ({
  rationale,
  edits: [{ path: 'src/math.js', search: 'a - b', replace: `a ${op} b` }],
});

class ScriptedLlm implements LlmClient {
  readonly requests: LlmFixRequest[] = [];
  constructor(private readonly replies: (Reply | (() => Reply))[]) {}
  async proposeEdits(req: LlmFixRequest): Promise<unknown> {
    this.requests.push(req);
    const r = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)]!;
    return typeof r === 'function' ? r() : r;
  }
}

async function resurrect(llm: LlmClient | null, config: Partial<PipelineConfig> = {}, files = FILES) {
  const repo = await makeRepo(files);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const pipeline = new ResurrectionPipeline(
    {
      sandbox: new FakeSandbox(world),
      registry: new FakeRegistry({}),
      llm,
      sink,
      reporter,
      clock: fakeClock(),
    },
    { ...CONFIG, ...config },
  );
  const outcome = await pipeline.run({
    jobId: 'job-llm',
    repo: { owner: 'ghost', name: 'calc', url: 'https://github.com/ghost/calc' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'd'.repeat(40), commitDate: '2022-01-01T00:00:00Z' },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, tree, sink };
}

describe('AI-assisted source fixes', () => {
  it('without an LLM a source bug stays unfixed', async () => {
    const { outcome } = await resurrect(null);
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.patch).toBe('');
  });

  it('fixes a bug in project source, and the patch contains the source file', async () => {
    const llm = new ScriptedLlm([fixAdd()]);
    const { outcome, tree } = await resurrect(llm);
    expect(outcome.health).toBe('REVIVED');
    const kept = outcome.attempts.filter((a) => a.status === 'VERIFIED');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.strategyId).toBe('llm-source-fix');
    expect(kept[0]!.files).toEqual(['src/math.js']);
    expect(tree['src/math.js']).toBe('exports.add = (a, b) => a + b;\n');
    expect(tree['test/math.test.js']).toBe(FILES['test/math.test.js']);

    const [p] = parsePatch(outcome.patch);
    expect(p?.newFileName).toBe('b/src/math.js');
    expect(applyPatch(FILES['src/math.js']!, p!)).toBe('exports.add = (a, b) => a + b;\n');

    // The model saw the failing source, the test, what src/index.js-style neighbours exist, and the layout.
    const req = llm.requests[0]!;
    expect(req.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['package.json', 'src/math.js', 'test/math.test.js']),
    );
    expect(req.tree).toEqual(expect.arrayContaining(['src/index.js', 'src/math.js', 'test/math.test.js']));
  });

  it('shows the model what its reverted attempt caused, then accepts the corrected fix', async () => {
    const llm = new ScriptedLlm([wrong('*'), fixAdd()]);
    const { outcome } = await resurrect(llm);
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.attempts.map((a) => a.status)).toEqual(['REVERTED', 'VERIFIED']);
    const second = llm.requests[1]!;
    const prior = second.priorAttempts!.find((a) => a.status === 'REVERTED')!;
    expect(prior.detail).toContain('After this change test failed');
    expect(prior.detail).toContain('expected 6 to equal 5');
  });

  it('stops after LLM_MAX_ATTEMPTS_PER_ISSUE proposals for one issue', async () => {
    const ops = ['*', '/', '%', '**', '|'];
    let i = 0;
    const llm = new ScriptedLlm([() => wrong(ops[i++ % ops.length]!)]);
    const { outcome } = await resurrect(llm, { llmMaxPerIssue: 2 });
    expect(llm.requests.length).toBeLessThanOrEqual(3);
    expect(outcome.attempts.filter((a) => a.strategyId === 'llm-source-fix')).toHaveLength(2);
    expect(outcome.attempts.every((a) => a.status !== 'VERIFIED')).toBe(true);
    expect(outcome.patch).toBe('');
  });

  it('never tries the same edits twice, even with a different explanation', async () => {
    let n = 0;
    const llm = new ScriptedLlm([() => wrong('*', `Different words ${n++}.`)]);
    const { outcome } = await resurrect(llm, { llmMaxPerIssue: 5 });
    expect(outcome.attempts.filter((a) => a.strategyId === 'llm-source-fix')).toHaveLength(1);
  });

  it('rejects edits that skip or delete tests, and leaves the repository untouched', async () => {
    const skip: Reply = {
      rationale: 'Skip the failing test.',
      edits: [{ path: 'test/math.test.js', search: "it('adds'", replace: "it.skip('adds'" }],
    };
    const gut: Reply = {
      rationale: 'Remove the test.',
      edits: [{ path: 'test/math.test.js', search: FILES['test/math.test.js']!, replace: '// nothing\n' }],
    };
    const noop: Reply = {
      rationale: 'Make the script pass.',
      edits: [{ path: 'package.json', search: '"test": "mocha"', replace: '"test": "echo ok"' }],
    };
    for (const reply of [skip, gut, noop]) {
      const { outcome, tree } = await resurrect(new ScriptedLlm([reply]));
      expect(outcome.attempts.some((a) => a.strategyId === 'llm-source-fix')).toBe(false);
      expect(outcome.health).toBe('UNRECOVERABLE');
      expect(tree['test/math.test.js']).toBe(FILES['test/math.test.js']);
      expect(tree['package.json']).toBe(FILES['package.json']);
    }
  });

  it('refuses paths outside the allowed set', async () => {
    const reply: Reply = {
      rationale: 'Edit the workflow.',
      edits: [{ path: '.github/workflows/ci.yml', search: '', replace: 'on: push\n' }],
    };
    const { outcome, tree } = await resurrect(new ScriptedLlm([reply]));
    expect(outcome.patch).toBe('');
    expect(Object.keys(tree)).not.toContain('.github/workflows/ci.yml');
  });

  it('lists kept AI fixes in the pull request body for review', async () => {
    const { outcome } = await resurrect(new ScriptedLlm([fixAdd('add() subtracts instead of adding.')]));
    const body = buildPrBody({
      report: outcome.report,
      baseBranch: 'main',
      excluded: [],
      reportUrl: null,
      jobId: 'job-llm',
    });
    expect(body).toContain('### AI-assisted changes');
    expect(body).toContain('`src/math.js`');
    expect(body).toContain('add() subtracts instead of adding.');
    expect(body).toMatch(/read them like any other contribution/);
  });

  it('PR bodies without AI fixes have no AI section', async () => {
    const healthy = {
      ...FILES,
      'src/math.js': 'exports.add = (a, b) => a + b;\n',
    };
    const { outcome } = await resurrect(new ScriptedLlm([fixAdd()]), {}, healthy);
    const body = buildPrBody({
      report: outcome.report,
      baseBranch: 'main',
      excluded: [],
      reportUrl: null,
      jobId: 'x',
    });
    expect(body).not.toContain('AI-assisted changes');
  });
});
