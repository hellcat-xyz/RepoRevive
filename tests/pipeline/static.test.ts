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
} from '../helpers/fake-world';

const CONFIG: PipelineConfig = {
  maxAttempts: 6,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

async function resurrect(files: Record<string, string>) {
  const repo = await makeRepo(files);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  // Any sandbox command would throw: a static site must never reach Docker.
  const sandbox = new FakeSandbox(() => {
    throw new Error('the sandbox must not be used for a static site');
  });
  let imagesEnsured = 0;
  const ensureImage = sandbox.ensureImage.bind(sandbox);
  sandbox.ensureImage = async () => {
    imagesEnsured++;
    return ensureImage();
  };
  const pipeline = new ResurrectionPipeline(
    { sandbox, registry: new FakeRegistry({}), llm: null, sink, reporter, clock: fakeClock() },
    CONFIG,
  );
  const outcome = await pipeline.run({
    jobId: 'job-static',
    repo: {
      owner: 'DS013git',
      name: 'Guess-The-Number-Game',
      url: 'https://github.com/DS013git/Guess-The-Number-Game',
    },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'c'.repeat(40), commitDate: '2025-07-01T19:21:58+05:30' },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, sink, reporter, sandbox, imagesEnsured, tree };
}

// The layout of DS013git/Guess-The-Number-Game: index.html + styles.css + script.js, no manifest.
const GUESS_GAME: Record<string, string> = {
  'README.md': '# Guess The Number',
  'index.html':
    '<!DOCTYPE html><html><head><title>Guess the Number Game</title><link rel="stylesheet" href="styles.css"></head>' +
    '<body><!-- <img src="gone.png"> --><script src="script.js"></script></body></html>',
  'styles.css': 'body { background: url(pic/bg.png); }',
  'script.js': 'console.log(1);',
  'pic/bg.png': 'png',
};

describe('static site resurrection', () => {
  it('accepts a healthy static site without starting any container', async () => {
    const { outcome, sandbox, imagesEnsured } = await resurrect(GUESS_GAME);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.report.ecosystem).toBe('static');
    expect(outcome.report.headline).toMatch(/static site is healthy/);
    expect(outcome.report.headline).not.toMatch(/installs, builds, and tests/);
    expect(outcome.report.coverage?.level).toBe('none');
    expect(outcome.report.coverage?.testedFunctionally).toBe(false);
    expect(outcome.attempts).toEqual([]);
    expect(outcome.patch).toBe('');
    expect(sandbox.runs).toEqual([]);
    expect(imagesEnsured).toBe(0);
  });

  it('fixes letter-case references and labels them verified (static), never verified (runtime)', async () => {
    const files = {
      ...GUESS_GAME,
      'index.html': GUESS_GAME['index.html']!.replace('styles.css', 'Styles.css').replace(
        'script.js',
        'Script.JS',
      ),
      'styles.css': 'body { background: url(pic/BG.png); }',
    };
    const { outcome, tree } = await resurrect(files);
    expect(outcome.health).toBe('REVIVED');
    expect(outcome.attempts.map((a) => a.status).sort()).toEqual([
      'VERIFIED_STATIC',
      'VERIFIED_STATIC',
      'VERIFIED_STATIC',
    ]);
    expect(outcome.attempts.some((a) => a.status === 'VERIFIED')).toBe(false);
    expect(outcome.attempts[0]!.reason).toMatch(/not executed/);
    expect(tree['index.html']).toContain('href="styles.css"');
    expect(tree['index.html']).toContain('src="script.js"');
    expect(tree['styles.css']).toContain('pic/bg.png');
    expect(outcome.report.headline).toMatch(/Revived/);
    expect(outcome.report.coverage?.limitations.join(' ')).toMatch(/nothing was installed/i);
  });

  it('produces a patch that applies to the original files', async () => {
    const files = {
      ...GUESS_GAME,
      'index.html': GUESS_GAME['index.html']!.replace('styles.css', 'STYLES.css'),
    };
    const { outcome } = await resurrect(files);
    const [p] = parsePatch(outcome.patch);
    expect(p?.newFileName).toBe('b/index.html');
    const patched = applyPatch(files['index.html']!, p!);
    expect(patched).toContain('href="styles.css"');
  });

  it('never invents a missing file: unfixable references stay broken and are only suggested', async () => {
    const files = {
      ...GUESS_GAME,
      'index.html': GUESS_GAME['index.html']!.replace('script.js', 'missing.js'),
    };
    const { outcome, tree } = await resurrect(files);
    expect(outcome.health).toBe('UNRECOVERABLE');
    expect(outcome.attempts.map((a) => a.status)).toEqual(['SUGGESTED']);
    expect(outcome.patch).toBe('');
    expect(tree['index.html']).toBe(files['index.html']);
    expect(Object.keys(tree).sort()).toEqual(Object.keys(files).sort());
    expect(outcome.report.remainingIssues.map((i) => i.kind)).toEqual(['broken-reference']);
  });

  it('is partially revived when only some references can be fixed', async () => {
    const files = {
      ...GUESS_GAME,
      'index.html': GUESS_GAME['index.html']!.replace('styles.css', 'Styles.css').replace(
        'script.js',
        'missing.js',
      ),
    };
    const { outcome } = await resurrect(files);
    expect(outcome.health).toBe('PARTIALLY_REVIVED');
    expect(outcome.attempts.filter((a) => a.status === 'VERIFIED_STATIC')).toHaveLength(1);
  });

  it('renders a readable report', async () => {
    const { outcome } = await resurrect(GUESS_GAME);
    const md = reportToMarkdown(outcome.report);
    expect(md).toContain('Static site');
    expect(md).toContain('Nothing was executed');
  });
});
