import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems, ECOSYSTEMS } from '@/engine/ecosystems';
import { diagnoseGo, goEcosystem, parseGoMod, selectGoRuntime } from '@/engine/ecosystems/go';
import { escapeModulePath, HttpGoProxyRegistry } from '@/engine/ecosystems/go/registry-http';
import { setModuleVersion } from '@/engine/ecosystems/go/strategies';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  makeRepo,
  MemoryReporter,
  simplePackument,
  type World,
} from '../helpers/fake-world';

const CONFIG: PipelineConfig = {
  maxAttempts: 6,
  jobTimeoutMs: 3_600_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};
const GO_MOD =
  'module example.com/app\n\ngo 1.20\n\nrequire (\n\tgithub.com/pkg/errors v0.9.99\n\tgolang.org/x/text v0.3.7 // indirect\n)\n';
const PROXY = new FakeRegistry({
  'github.com/pkg/errors': simplePackument('github.com/pkg/errors', [
    ['0.8.1', '2019-01-01T00:00:00Z'],
    ['0.9.0', '2019-06-20T00:00:00Z'],
    ['0.9.1', '2020-01-14T00:00:00Z'],
    ['0.9.2', '2021-06-01T00:00:00Z'],
  ]),
});
const base = {
  'main.go': 'package main\nfunc main() {}\n',
  'main_test.go': 'package main\nimport "testing"\nfunc TestX(t *testing.T) {}\n',
};
const ok = { exitCode: 0, output: 'ok' };

async function resurrect(files: Record<string, string>, commitDate: string, world: World) {
  const repo = await makeRepo(files);
  const sandbox = new FakeSandbox(world);
  const outcome = await new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      registries: { go: PROXY },
      llm: null,
      sink: new MemoryEventSink(),
      reporter: new MemoryReporter(),
      clock: fakeClock(),
    },
    CONFIG,
  ).run({
    jobId: 'job-go',
    repo: { owner: 'g', name: 'go', url: 'https://github.com/g/go' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'd'.repeat(40), commitDate },
  });
  await repo.cleanup();
  return { outcome, sandbox };
}

describe('go modules', () => {
  it('parses go.mod and picks the runtime from go.mod, toolchain, or .go-version', () => {
    const m = parseGoMod(GO_MOD + 'toolchain go1.22.3\n');
    expect(m).toMatchObject({ module: 'example.com/app', goDirective: '1.20', toolchain: '1.22.3' });
    expect(m.requires.map((r) => [r.path, r.indirect])).toEqual([
      ['github.com/pkg/errors', false],
      ['golang.org/x/text', true],
    ]);
    expect(selectGoRuntime({ goVersionFile: null, mod: parseGoMod(GO_MOD), work: null })).toMatchObject({
      family: 'go',
      image: 'golang:1.20',
      version: '1.20',
    });
    expect(selectGoRuntime({ goVersionFile: '1.18', mod: parseGoMod(GO_MOD), work: null }).image).toBe(
      'golang:1.18',
    );
    expect(selectGoRuntime({ goVersionFile: null, mod: null, work: null }).image).toBe('golang:1.22');
    expect(
      selectGoRuntime({ goVersionFile: null, mod: parseGoMod('module a\ngo 1.9\n'), work: null }).warnings[0],
    ).toMatch(/predates/);
  });

  it('detects go.mod/go.sum/go.work and analyses the module', async () => {
    const repo = await makeRepo({ ...base, 'go.mod': GO_MOD, 'go.sum': '', 'go.work': 'go 1.21\nuse .\n' });
    const ws = await Workspace.open(repo.repoDir);
    const d = await detectEcosystems(ws, ECOSYSTEMS);
    expect(d.selected?.ecosystem.id).toBe('go');
    const a = await goEcosystem.analyze(ws);
    expect(a).toMatchObject({
      ecosystem: 'go',
      hasTests: true,
      projectName: 'example.com/app',
      isMonorepo: true,
    });
    const plan = await goEcosystem.plan(ws, await goEcosystem.selectRuntime(ws), CONFIG.timeouts);
    expect(plan.map((p) => p.command?.join(' '))).toEqual([
      'go mod download',
      'go build ./...',
      'go test ./...',
    ]);
    expect(plan.map((p) => p.network)).toEqual(['bridge', 'none', 'none']);
    await repo.cleanup();
  });

  it('diagnoses common module failures and never auto-repairs checksum mismatches', () => {
    const d = (step: 'install' | 'build' | 'test', logTail: string) =>
      diagnoseGo({ step, status: 'failed', logTail });
    expect(
      d(
        'install',
        'go: github.com/pkg/errors@v0.9.99: reading github.com/pkg/errors/go.mod at revision v0.9.99: unknown revision v0.9.99',
      )[0],
    ).toBeDefined();
    expect(
      d('install', 'go: github.com/pkg/errors@v0.9.99: invalid version: unknown revision v0.9.99')[0],
    ).toMatchObject({
      kind: 'missing-version',
      data: { module: 'github.com/pkg/errors', version: 'v0.9.99' },
    });
    expect(d('build', 'main.go:3:2: missing go.sum entry for module providing package x')[0]?.kind).toBe(
      'lockfile-drift',
    );
    expect(
      d('build', 'main.go:3:2: no required module provides package github.com/x/y; to add it:')[0],
    ).toMatchObject({ kind: 'missing-module' });
    expect(
      d('install', 'go: go.mod requires go >= 1.22 (running go 1.20.1; GOTOOLCHAIN=local)')[0],
    ).toMatchObject({ kind: 'toolchain-mismatch', data: { required: '1.22' } });
    expect(d('install', 'verifying module: checksum mismatch\n\tSECURITY ERROR')[0]?.kind).toBe(
      'lockfile-corrupt',
    );
    expect(d('build', './main.go:5:2: undefined: foo')[0]).toMatchObject({
      kind: 'compile-error',
      diagnostic: { file: 'main.go' },
    });
    expect(d('test', '--- FAIL: TestX (0.00s)\nFAIL')[0]?.kind).toBe('test-failure');
    expect(goEcosystem.strategies.some((s) => s.handles.includes('lockfile-corrupt'))).toBe(false);
  });

  it('go proxy client escapes paths, ignores pseudo-versions and reads times', async () => {
    expect(escapeModulePath('github.com/Azure/go')).toBe('github.com/!azure/go');
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      if (u.endsWith('/@v/list')) return new Response('v1.0.0\nv1.1.0\nv1.2.0-rc1\nv0.0.0-20200101-abc\n');
      return new Response(
        JSON.stringify({ Time: u.includes('v1.1.0') ? '2021-01-01T00:00:00Z' : '2020-01-01T00:00:00Z' }),
      );
    }) as unknown as typeof fetch;
    const p = await new HttpGoProxyRegistry('https://p', 1000, f).packument('github.com/Azure/go');
    expect(p).toMatchObject({ versions: ['1.0.0', '1.1.0'], time: { '1.1.0': '2021-01-01T00:00:00Z' } });
    expect(urls[0]).toBe('https://p/github.com/!azure/go/@v/list');
    expect(await new HttpGoProxyRegistry('https://p', 1000, f).packument('../etc')).toBeNull();
  });

  it('setModuleVersion edits only the named requirement', () => {
    expect(setModuleVersion(GO_MOD, 'github.com/pkg/errors', 'v0.9.1')).toContain(
      'github.com/pkg/errors v0.9.1',
    );
    expect(setModuleVersion(GO_MOD, 'github.com/other', 'v1.0.0')).toBeNull();
  });

  it('fixture: nonexistent module version is re-pinned to an era release and go.sum is regenerated', async () => {
    const r = await resurrect(
      { ...base, 'go.mod': GO_MOD, 'go.sum': 'old\n' },
      '2020-02-01T00:00:00Z',
      (v) => {
        if (v.label === 'lockfile') return { exitCode: 0, output: 'tidy', writes: { 'go.sum': 'new-sum\n' } };
        if (v.label === 'install' && v.read('go.mod')?.includes('v0.9.99'))
          return {
            exitCode: 1,
            output: 'go: github.com/pkg/errors@v0.9.99: invalid version: unknown revision v0.9.99',
          };
        return ok;
      },
    );
    expect(r.outcome.health).toBe('REVIVED');
    const changes = Object.fromEntries(r.outcome.workspace!.changes().map((c) => [c.path, c.after]));
    expect(Object.keys(changes).sort()).toEqual(['go.mod', 'go.sum']);
    expect(changes['go.mod']).toContain('github.com/pkg/errors v0.9.1');
    expect(changes['go.sum']).toBe('new-sum\n');
    expect(r.sandbox.runs.every((x) => x.image === 'golang:1.20')).toBe(true);
  });

  it('fixture: stale go.sum is fixed by go mod tidy', async () => {
    const r = await resurrect(
      { ...base, 'go.mod': GO_MOD.replace('v0.9.99', 'v0.9.1'), 'go.sum': 'stale\n' },
      '2021-01-01T00:00:00Z',
      (v) => {
        if (v.label === 'lockfile') return { exitCode: 0, output: 'tidy', writes: { 'go.sum': 'fresh\n' } };
        if (v.label === 'build' && v.read('go.sum') === 'stale\n')
          return {
            exitCode: 1,
            output: 'main.go:3:2: missing go.sum entry for module providing package github.com/pkg/errors',
          };
        return ok;
      },
    );
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace!.changes().map((c) => c.path)).toEqual(['go.sum']);
    expect(r.outcome.attempts.find((a) => a.status === 'VERIFIED')?.strategyId).toBe('go-mod-tidy');
  });

  it('fixture: toolchain requirement selects a newer approved image via .go-version', async () => {
    const r = await resurrect(
      { ...base, 'go.mod': GO_MOD.replace('v0.9.99', 'v0.9.1') },
      '2024-05-01T00:00:00Z',
      (v) =>
        v.command.join(' ').startsWith('go build') && v.read('.go-version') === null
          ? { exitCode: 1, output: 'go: go.mod requires go >= 1.22 (running go 1.20.1; GOTOOLCHAIN=local)' }
          : ok,
    );
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace!.changes()).toMatchObject([{ path: '.go-version', after: '1.22\n' }]);
    expect(r.sandbox.runs.some((x) => x.image === 'golang:1.22')).toBe(true);
  });
});
