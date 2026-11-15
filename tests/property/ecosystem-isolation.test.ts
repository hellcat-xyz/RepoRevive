import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems, ECOSYSTEMS } from '@/engine/ecosystems';
import {
  detectPackageManager,
  installCommand,
  runScriptCommand,
} from '@/engine/ecosystems/npm/package-manager';
import { npmEcosystem } from '@/engine/ecosystems/npm';
import { isAllowedLlmPath, llmSourceFix, materializeEdits } from '@/engine/llm/llm-strategy';
import { SUPPORTED_ECOSYSTEMS } from '@/lib/ecosystems';
import { PY_FIXTURES } from '../fixtures/projects/python';
import { RUST_FIXTURES } from '../fixtures/projects/rust';
import { makeRepo } from '../helpers/fake-world';
import type { LlmClient, LlmFixRequest } from '@/engine/core/ports';
import type { StrategyContext } from '@/engine/ecosystems/types';
import type { VerificationResult } from '@/engine/core/types';

const FIXTURES: Record<string, Record<string, string>> = {
  python: PY_FIXTURES.dependencyFailure.files,
  rust: RUST_FIXTURES.missingCrate.files,
  go: { 'go.mod': 'module a\ngo 1.21\n', 'main.go': 'package main\n' },
  maven: { 'pom.xml': '<project><artifactId>a</artifactId></project>' },
  npm: { 'package.json': '{"name":"x","scripts":{"build":"tsc"}}', 'package-lock.json': '{}' },
};

describe('ecosystem isolation', () => {
  it('every registered ecosystem has unique id and its own strategy objects with unique ids', () => {
    const ids = new Set<string>();
    const objs = new Set<unknown>();
    expect(new Set(ECOSYSTEMS.map((e) => e.id)).size).toBe(ECOSYSTEMS.length);
    for (const e of ECOSYSTEMS)
      for (const s of e.strategies) {
        expect(ids.has(s.id), `duplicate strategy id ${s.id}`).toBe(false);
        expect(objs.has(s), 'strategy object shared between ecosystems').toBe(false);
        ids.add(s.id);
        objs.add(s);
      }
  });

  it('P: a project is detected as exactly its own ecosystem (and analysed as that ecosystem)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...Object.keys(FIXTURES)), async (id) => {
        const repo = await makeRepo(FIXTURES[id]!);
        try {
          const ws = await Workspace.open(repo.repoDir);
          const d = await detectEcosystems(ws, ECOSYSTEMS);
          expect(d.selected?.ecosystem.id).toBe(id);
          expect((await d.selected!.ecosystem.analyze(ws)).ecosystem).toBe(id);
          expect(d.ambiguous).toBe(false);
          // The runtime image family always matches the ecosystem's family.
          expect((await d.selected!.ecosystem.selectRuntime(ws)).family).toBe(d.selected!.ecosystem.family);
        } finally {
          await repo.cleanup();
        }
      }),
      { numRuns: 15 },
    );
  });

  it('only fully implemented ecosystems are advertised in the UI', () => {
    for (const e of SUPPORTED_ECOSYSTEMS) expect(ECOSYSTEMS.map((x) => x.id)).toContain(e.id);
  });

  it('JavaScript commands never appear in other ecosystems plans', async () => {
    for (const [id, files] of Object.entries(FIXTURES)) {
      if (id === 'npm') continue;
      const repo = await makeRepo({ ...files, 'test_x.py': 'def test_a(): pass\n' });
      const ws = await Workspace.open(repo.repoDir);
      const eco = ECOSYSTEMS.find((e) => e.id === id)!;
      const plan = await eco.plan(ws, await eco.selectRuntime(ws), { install: 1, build: 1, test: 1 });
      for (const p of plan) expect((p.command ?? []).join(' ')).not.toMatch(/\b(npm|npx|yarn|pnpm|node)\b/);
      await repo.cleanup();
    }
  });
});

describe('Node package managers', () => {
  it('chooses the manager from packageManager, then lockfiles, and installs/runs with it', async () => {
    const mk = async (files: Record<string, string>) =>
      detectPackageManager(await Workspace.open((await makeRepo(files)).repoDir));
    expect(await mk({ 'package.json': '{"packageManager":"pnpm@9.1.0"}' })).toMatchObject({
      manager: 'pnpm',
      version: '9.1.0',
    });
    expect(await mk({ 'package.json': '{}', 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n" })).toMatchObject({
      manager: 'pnpm',
      version: '8.15.9',
    });
    expect(await mk({ 'package.json': '{}', 'yarn.lock': '# yarn lockfile v1\n' })).toMatchObject({
      manager: 'yarn',
      berry: false,
      version: '1.22.22',
    });
    expect(await mk({ 'package.json': '{}', 'yarn.lock': '__metadata:\n  version: 6\n' })).toMatchObject({
      manager: 'yarn',
      berry: true,
    });
    expect(await mk({ 'package.json': '{}', 'package-lock.json': '{}', 'yarn.lock': 'x' })).toMatchObject({
      manager: 'npm',
    });
    expect(await mk({ 'package.json': '{"packageManager":"yarn@4.1.0"}' })).toMatchObject({
      manager: 'yarn',
      berry: true,
    });
    const pnpm = { manager: 'pnpm' as const, version: '8.15.9', berry: false, source: 't' };
    expect(installCommand(pnpm)!.join(' ')).toContain('pnpm install --frozen-lockfile');
    expect(runScriptCommand(pnpm, 'test').join(' ')).toContain('pnpm run test');
    expect(installCommand({ manager: 'npm', version: null, berry: false, source: 't' })).toBeNull();
  });

  it('the npm ecosystem plan uses pnpm for a pnpm project and keeps npm ci for npm', async () => {
    const p = await makeRepo({
      'package.json': '{"scripts":{"build":"tsc","test":"vitest"}}',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    const ws = await Workspace.open(p.repoDir);
    const plan = await npmEcosystem.plan(ws, await npmEcosystem.selectRuntime(ws), {
      install: 1,
      build: 1,
      test: 1,
    });
    expect(plan[0]!.command!.join(' ')).toContain('pnpm@9.12.3');
    expect(plan[0]!.network).toBe('bridge');
    expect(plan[2]!.command!.join(' ')).toContain('pnpm run test');
    expect((await npmEcosystem.analyze(ws)).packageManager).toBe('pnpm');
    const n = await makeRepo({ 'package.json': '{"scripts":{"build":"tsc"}}', 'package-lock.json': '{}' });
    const nws = await Workspace.open(n.repoDir);
    expect(
      (
        await npmEcosystem.plan(nws, await npmEcosystem.selectRuntime(nws), { install: 1, build: 1, test: 1 })
      )[0]!.command,
    ).toEqual(['npm', 'ci', '--no-audit', '--no-fund', '--no-update-notifier']);
  });
});

describe('multi-language AI repair', () => {
  it('rejects lockfiles, credentials, CI and dependency directories for every ecosystem', () => {
    for (const p of [
      'Cargo.lock',
      'poetry.lock',
      'uv.lock',
      'Pipfile.lock',
      'go.sum',
      'pnpm-lock.yaml',
      '.env',
      '.env.production',
      '.pypirc',
      '.github/workflows/ci.yml',
      'target/debug/x.rs',
      'venv/lib/x.py',
      '.cargo/config.toml',
      'deploy/server.pem',
      'a/.netrc',
      'vendor/x/y.go',
      '../x.py',
    ])
      expect(isAllowedLlmPath(p), p).toBe(false);
    for (const p of [
      'src/lib.rs',
      'app/main.py',
      'cmd/main.go',
      'src/main/java/A.java',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      'pom.xml',
    ])
      expect(isAllowedLlmPath(p), p).toBe(true);
  });

  it('sends ecosystem, package manager, command and prior attempts, then validates the answer', async () => {
    const repo = await makeRepo({
      'Cargo.toml': '[package]\nname="a"\n',
      'src/lib.rs': 'fn a() -> u32 { "x" }\n',
    });
    const ws = await Workspace.open(repo.repoDir);
    let seen: LlmFixRequest | null = null;
    const llm: LlmClient = {
      async proposeEdits(req) {
        seen = req;
        return {
          rationale: 'Return a number.',
          edits: [{ path: 'src/lib.rs', search: '"x"', replace: '1' }],
        };
      },
    };
    const step = {
      step: 'build' as const,
      status: 'failed' as const,
      command: 'cargo check',
      logTail: 'error[E0308]: mismatched types\n --> src/lib.rs:1:21',
      durationMs: 1,
    };
    const current = {
      runtime: 'rust:1.85-slim',
      score: 40,
      issues: [],
      steps: {
        install: { ...step, step: 'install' as const, status: 'passed' as const },
        build: step,
        test: { ...step, step: 'test' as const, status: 'skipped' as const },
      },
    } as VerificationResult;
    const ctx = {
      ws,
      runtime: {
        family: 'rust',
        version: '1.85',
        image: 'rust:1.85-slim',
        label: 'Rust 1.85',
        major: 1,
        source: 't',
        warnings: [],
      },
      commitDate: null,
      registry: { packument: async () => null },
      sandbox: { regenerateLockfile: async () => null, regenerateFiles: async () => [] },
      llm,
      ecosystem: { id: 'rust', packageManager: 'cargo' },
      attempts: [{ title: 'Pin Rust 1.50', status: 'REVERTED', reason: 'No measurable improvement.' }],
      current,
      log: () => undefined,
    } as unknown as StrategyContext;
    const proposals = await llmSourceFix.propose(
      {
        kind: 'compile-error',
        fingerprint: 'c',
        step: 'build',
        severity: 'error',
        title: 'Compilation failed',
        evidence: '',
        diagnostic: { category: 'compile-error', message: 'x', file: 'src/lib.rs' },
      },
      ctx,
    );
    expect(seen).toMatchObject({
      ecosystem: 'rust',
      packageManager: 'cargo',
      command: 'cargo check',
      priorAttempts: [{ status: 'REVERTED' }],
    });
    expect(seen!.files.map((f) => f.path)).toEqual(expect.arrayContaining(['Cargo.toml', 'src/lib.rs']));
    expect(proposals[0]!.edits).toEqual([{ path: 'src/lib.rs', content: 'fn a() -> u32 { 1 }\n' }]);
    // Ambiguous or disallowed edits are refused.
    expect(
      await materializeEdits({ ws }, [{ path: 'Cargo.lock', search: 'a', replace: 'b' }]),
    ).toHaveProperty('error');
    expect(
      await materializeEdits({ ws }, [{ path: 'src/lib.rs', search: ' ', replace: '_' }]),
    ).toHaveProperty('error');
    await repo.cleanup();
  });
});
