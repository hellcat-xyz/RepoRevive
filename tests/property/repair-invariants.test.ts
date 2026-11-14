import fc from 'fast-check';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import type { FixProposal, Issue } from '@/engine/core/types';
import { validateRelativePath, Workspace } from '@/engine/core/workspace';
import { npmEcosystem } from '@/engine/ecosystems/npm';
import {
  findFloatingRawRefs,
  rewriteRawRefs,
  upstreamRefPin,
} from '@/engine/ecosystems/npm/upstream-strategies';
import type { FixStrategy } from '@/engine/ecosystems/types';
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

const word = fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/);
const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/);
const ref = word.filter((r) => !/^[0-9a-f]{40}$/.test(r));

describe('P-R1: rewriteRawRefs only touches the ref segment and is a fixed point', () => {
  it('holds for arbitrary surrounding text and URLs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        word,
        word,
        ref,
        fc.array(word, { maxLength: 3 }),
        fc.string({ maxLength: 40 }),
        hex40,
        (before, owner, repo, r, segs, after, sha) => {
          const rest = segs.map((s) => `/${s}`).join('');
          const text = `${before}https://raw.githubusercontent.com/${owner}/${repo}/${r}${rest}'${after}`;
          const found = findFloatingRawRefs(text).filter((x) => x.owner === owner && x.repo === repo);
          expect(found.some((x) => x.ref === r)).toBe(true);
          const out = rewriteRawRefs(text, new Map([[`${owner}/${repo}@${r}`, sha]]));
          // Replacing the SHA back with the ref yields the original text: nothing else changed.
          expect(out.split(sha).join(r)).toBe(text);
          // Idempotent, and pinned URLs are no longer floating.
          expect(rewriteRawRefs(out, new Map([[`${owner}/${repo}@${r}`, sha]]))).toBe(out);
          expect(
            findFloatingRawRefs(out).some((x) => x.owner === owner && x.repo === repo && x.ref === sha),
          ).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('P-R2: the upstream strategy never targets paths outside the workspace', () => {
  it('rejects unsafe or forbidden script paths from untrusted diagnostics', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-prop-'));
    try {
      await fs.writeFile(
        path.join(dir, 'ok.mjs'),
        "const b='https://raw.githubusercontent.com/o/r/main/dir';\n",
      );
      await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","scripts":{}}');
      const ws = await Workspace.open(dir);
      const up = new FakeUpstream({ 'o/r@main': 'a'.repeat(40) }, new Set());
      const hostile = fc.oneof(
        fc.string({ maxLength: 30 }),
        fc.constantFrom(
          '../x.js',
          '/etc/passwd',
          'a\\b.js',
          'C:/x.js',
          'node_modules/p/x.js',
          '.git/hooks/pre-commit',
          '.github/workflows/ci.yml',
          'ok.mjs',
          'a/../../b.js',
        ),
      );
      await fc.assert(
        fc.asyncProperty(hostile, async (file) => {
          const issue: Issue = {
            kind: 'broken-upstream-resource',
            fingerprint: 'f',
            step: 'install',
            severity: 'error',
            title: 't',
            evidence: `> node ${file}`,
            data: { file },
            diagnostic: { category: 'upstream-resource', message: 'm', file, resources: [] },
          };
          const proposals = await upstreamRefPin.propose(issue, {
            ws,
            runtime: { image: 'node:22', label: 'Node.js 22', major: 22, source: 't', warnings: [] },
            commitDate: '2024-01-01T00:00:00Z',
            registry: new FakeRegistry({}),
            upstream: up,
            sandbox: { regenerateLockfile: async () => null },
            llm: null,
            current: {} as never,
            log: () => undefined,
          });
          for (const p of proposals)
            for (const e of p.edits) {
              expect(() => validateRelativePath(e.path)).not.toThrow();
              expect(e.path.split('/')).not.toContain('node_modules');
              expect(e.path.split('/')).not.toContain('.git');
              expect(e.path.split('/')).not.toContain('.github');
            }
        }),
        { numRuns: 100 },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- pipeline-level invariants

const CONFIG: PipelineConfig = {
  maxAttempts: 5,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};

const FILES = { 'package.json': '{"name":"gen","version":"1.0.0","scripts":{}}\n', 'README.md': '# hi\n' };

/** A strategy that proposes `count` distinct candidates, candidate i writing `fix-i.txt`. */
function generator(count: number): FixStrategy {
  return {
    id: 'gen',
    handles: ['unknown'],
    invasiveness: 1,
    async propose(): Promise<FixProposal[]> {
      return Array.from({ length: count }, (_, i) => ({
        strategyId: 'gen',
        title: `candidate ${i}`,
        rationale: `writes fix-${i}.txt`,
        edits: [{ path: `fix-${i}.txt`, content: `fix ${i}\n` }],
        kind: 'runtime' as const,
      }));
    },
  };
}

async function runGenerated(opts: { count: number; good: number | null; maxAttempts: number }) {
  const repo = await makeRepo(FILES);
  const sink = new MemoryEventSink();
  const reporter = new MemoryReporter();
  const world: World = (v) =>
    v.label === 'install' && (opts.good === null || v.read(`fix-${opts.good}.txt`) === null)
      ? { exitCode: 1, output: 'mystery failure' }
      : { exitCode: 0, output: 'ok' };
  const sandbox = new FakeSandbox(world);
  const pipeline = new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      llm: null,
      sink,
      reporter,
      clock: fakeClock(),
      ecosystems: [{ ...npmEcosystem, strategies: [generator(opts.count)] }],
    },
    { ...CONFIG, maxAttempts: opts.maxAttempts },
  );
  const outcome = await pipeline.run({
    jobId: 'j',
    repo: { owner: 'o', name: 'gen', url: 'https://github.com/o/gen' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'b'.repeat(40), commitDate: '2024-01-01T00:00:00Z' },
  });
  const tree = await readTree(repo.repoDir);
  await repo.cleanup();
  return { outcome, tree, sandbox, reporter };
}

describe('pipeline repair invariants (generated strategies and worlds)', () => {
  it('P-R3/P-R4/P-R5/P-R6: bounded, evidence-backed, rollback-clean, and honestly reported', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
        fc.integer({ min: 0, max: 6 }),
        async (count, goodRaw, maxAttempts) => {
          const good = goodRaw !== null && goodRaw < count ? goodRaw : null;
          const { outcome, tree, sandbox, reporter } = await runGenerated({ count, good, maxAttempts });
          const installs = sandbox.runs.filter((r) => r.label === 'install').length;

          // Termination: baseline + at most maxAttempts candidates + one clean final verification.
          expect(installs).toBeLessThanOrEqual(maxAttempts + 2);
          const tried = outcome.attempts.filter((a) => a.status === 'VERIFIED' || a.status === 'REVERTED');
          expect(tried.length).toBeLessThanOrEqual(maxAttempts);

          const succeeds = good !== null && good + 1 <= maxAttempts;
          const extra = (name: string) => Object.keys(tree).filter((k) => !(k in FILES) && k === name);
          if (succeeds) {
            expect(outcome.health).toBe('REVIVED');
            expect(Object.keys(tree).filter((k) => k.startsWith('fix-'))).toEqual([`fix-${good}.txt`]);
            expect(outcome.patch).toContain(`fix-${good}.txt`);
          } else {
            // Failed candidates never modify the baseline.
            expect(outcome.health).not.toBe('REVIVED');
            expect(tree).toEqual(FILES);
            expect(outcome.patch).toBe('');
            expect(extra('fix-0.txt')).toEqual([]);
          }

          // Every VERIFIED attempt carries evidence; every REVERTED one a reason.
          for (const a of outcome.attempts) {
            if (a.status === 'VERIFIED') {
              expect(a.verification).toBeDefined();
              expect(Object.values(a.verification!.steps).some((s) => s.status === 'passed')).toBe(true);
              expect(a.reason).toBeTruthy();
            }
            if (a.status === 'REVERTED') expect(a.reason).toBeTruthy();
          }

          // The report reflects exactly what was recorded and persisted.
          expect(outcome.report.attempts).toEqual(outcome.attempts);
          expect(reporter.attempts).toEqual(outcome.attempts);
          const md = reportToMarkdown(outcome.report);
          for (const a of outcome.attempts) expect(md).toContain(a.title);
          const patched = [...outcome.patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
          const verifiedFiles = outcome.attempts
            .filter((a) => a.status === 'VERIFIED')
            .flatMap((a) => a.files);
          expect(patched.sort()).toEqual([...new Set(verifiedFiles)].sort());
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);
});
