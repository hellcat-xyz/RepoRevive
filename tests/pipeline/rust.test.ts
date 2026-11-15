import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems, ECOSYSTEMS } from '@/engine/ecosystems';
import { analyzeRustProject } from '@/engine/ecosystems/rust/analyze';
import { diagnoseCargoOutput } from '@/engine/ecosystems/rust/diagnose';
import { rustEcosystem } from '@/engine/ecosystems/rust';
import { eraRustMinor, selectRustRuntime } from '@/engine/ecosystems/rust/runtime';
import { setCrateVersion } from '@/engine/ecosystems/rust/strategies';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import { RUST_FIXTURES } from '../fixtures/projects/rust';
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
  maxAttempts: 8,
  jobTimeoutMs: 60 * 60_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};
const CRATES = new FakeRegistry({
  serde: simplePackument('serde', [
    ['1.0.120', '2021-01-20T00:00:00Z'],
    ['1.0.125', '2021-03-10T00:00:00Z'],
    ['1.0.200', '2024-04-01T00:00:00Z'],
  ]),
});
const ok = { exitCode: 0, output: 'Finished' };

async function resurrect(fx: { files: Record<string, string>; commitDate: string }, world: World) {
  const repo = await makeRepo(fx.files);
  const sandbox = new FakeSandbox(world);
  const pipeline = new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      registries: { rust: CRATES },
      llm: null,
      sink: new MemoryEventSink(),
      reporter: new MemoryReporter(),
      clock: fakeClock(),
    },
    CONFIG,
  );
  const outcome = await pipeline.run({
    jobId: 'job-rs',
    repo: { owner: 'ghost', name: 'rs', url: 'https://github.com/ghost/rs' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'c'.repeat(40), commitDate: fx.commitDate },
  });
  await repo.cleanup();
  return { outcome, sandbox };
}

describe('rust runtime', () => {
  it('selects an approved numeric toolchain and never a Node-style major', () => {
    expect(
      selectRustRuntime({
        channel: { source: 'rust-toolchain.toml', value: '1.70.0' },
        rustVersion: null,
        edition: null,
      }),
    ).toMatchObject({
      family: 'rust',
      image: 'rust:1.70-slim',
      version: '1.70',
    });
    const nightly = selectRustRuntime({
      channel: { source: 'rust-toolchain', value: 'nightly-2021-01-01' },
      rustVersion: null,
      edition: null,
    });
    expect(nightly.image).toBe('rust:1.85-slim');
    expect(nightly.warnings[0]).toMatch(/nightly/);
    expect(selectRustRuntime({ channel: null, rustVersion: '1.90', edition: '2021' }).image).toBe(
      'rust:1.90-slim',
    );
    expect(eraRustMinor('2021-03-20')).toBe(50);
  });
});

describe('rust detection and analysis', () => {
  it('analyzes a workspace with build scripts', async () => {
    const repo = await makeRepo(RUST_FIXTURES.workspace.files);
    const ws = await Workspace.open(repo.repoDir);
    const a = await analyzeRustProject(ws);
    expect(a).toMatchObject({ ecosystem: 'rust', packageManager: 'cargo', isMonorepo: true, hasTests: true });
    expect(a.details?.['Workspace members']).toBe('crates/a, crates/b');
    expect(a.details?.['Build scripts']).toBe('crates/b/build.rs');
    expect((await detectEcosystems(ws, ECOSYSTEMS)).selected?.ecosystem.id).toBe('rust');
    const plan = await rustEcosystem.plan(ws, await rustEcosystem.selectRuntime(ws), CONFIG.timeouts);
    expect(plan.map((p) => p.command?.join(' '))[1]).toContain('cargo check --workspace --all-targets');
    expect(plan[0]!.network).toBe('bridge');
    expect(plan[1]!.network).toBe('none');
    await repo.cleanup();
  });
});

describe('cargo diagnosis', () => {
  const d = (step: 'install' | 'build' | 'test', logTail: string) =>
    diagnoseCargoOutput({ result: { step, status: 'failed', logTail } });
  it('classifies failures', () => {
    expect(
      d(
        'install',
        'error: failed to select a version for the requirement `serde = "^1.0.9999"`\ncandidate versions found which didn\'t match: 1.0.200',
      )[0],
    ).toMatchObject({ kind: 'missing-version', data: { package: 'serde' } });
    expect(
      d(
        'build',
        'error: package `foo v1.0.0` cannot be built because it requires rustc 1.60 or newer, while the currently active rustc version is 1.50.0',
      )[0],
    ).toMatchObject({ kind: 'toolchain-mismatch', data: { required: '1.60' } });
    expect(d('install', 'error: failed to parse manifest\nfeature `edition2024` is required')[0]?.kind).toBe(
      'unsupported-edition',
    );
    expect(
      d(
        'install',
        'error: the lock file /workspace/Cargo.lock needs to be updated but --locked was passed',
      )[0]?.kind,
    ).toBe('lockfile-drift');
    expect(
      d(
        'build',
        'error: failed to run custom build command for `openssl-sys v0.9.1`\nCould not find openssl',
      )[0],
    ).toMatchObject({ kind: 'build-script-failure' });
    expect(d('build', 'error[E0432]: unresolved import `rand`')[0]).toMatchObject({
      kind: 'missing-module',
      data: { crate: 'rand' },
    });
    const ce = d(
      'build',
      'error[E0308]: mismatched types\n --> src/lib.rs:3:5\nerror: could not compile `demo` (lib) due to 1 previous error',
    );
    expect(ce[0]).toMatchObject({
      kind: 'compile-error',
      diagnostic: { file: 'src/lib.rs', package: 'demo' },
    });
    expect(d('test', 'test result: FAILED. 0 passed; 1 failed')[0]?.kind).toBe('test-failure');
  });
});

describe('setCrateVersion', () => {
  it('edits simple, inline-table and table dependencies only', () => {
    expect(setCrateVersion('[dependencies]\nserde = "1.0.9999"\n', 'serde', '1.0.125')).toContain(
      'serde = "1.0.125"',
    );
    expect(setCrateVersion('serde = { version = "9", features = ["derive"] }\n', 'serde', '1.0.1')).toContain(
      'version = "1.0.1", features',
    );
    expect(setCrateVersion('[dependencies]\nother = "1"\n', 'serde', '1')).toBeNull();
  });
});

describe('rust pipeline fixtures (scripted sandbox)', () => {
  it('re-pins a nonexistent crate version to an era release', async () => {
    const r = await resurrect(RUST_FIXTURES.missingCrate, (v) => {
      if (v.label === 'install' && /1\.0\.9999/.test(v.read('Cargo.toml') ?? ''))
        return {
          exitCode: 101,
          output:
            'error: failed to select a version for the requirement `serde = "^1.0.9999"`\ncandidate versions found which didn\'t match: 1.0.200',
        };
      return ok;
    });
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace?.changes()).toMatchObject([{ path: 'Cargo.toml' }]);
    expect(r.outcome.workspace?.changes()[0]!.after).toContain('serde = "1.0.125"');
    expect(r.outcome.attempts.find((a) => a.status === 'VERIFIED')?.strategyId).toBe('rust-repin-crate');
    expect(r.sandbox.runs.every((x) => x.image.startsWith('rust:'))).toBe(true);
    expect(r.sandbox.runs.find((x) => x.label === 'build')?.network).toBe('none');
  });

  it('pins a newer toolchain when a crate requires it', async () => {
    const r = await resurrect(RUST_FIXTURES.toolchainMismatch, (v) =>
      v.label !== 'install' &&
      v.command.join(' ').includes('cargo check') &&
      v.read('rust-toolchain.toml')?.includes('1.50.0')
        ? {
            exitCode: 101,
            output:
              'error: package `foo v1.0.0` cannot be built because it requires rustc 1.60 or newer, while the currently active rustc version is 1.50.0',
          }
        : ok,
    );
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace?.changes()).toMatchObject([
      { path: 'rust-toolchain.toml', after: '[toolchain]\nchannel = "1.60"\n' },
    ]);
    expect(r.sandbox.runs.some((x) => x.image === 'rust:1.60-slim')).toBe(true);
  });

  it('falls back to the era compiler for a compile error (never claims success otherwise)', async () => {
    const r = await resurrect(RUST_FIXTURES.compilationFailure, (v) =>
      v.label === 'build' && v.command.join(' ').includes('cargo check') && !v.read('rust-toolchain.toml')
        ? {
            exitCode: 101,
            output:
              'error[E0308]: mismatched types\n --> src/lib.rs:3:5\nerror: could not compile `demo` (lib) due to 1 previous error',
          }
        : ok,
    );
    expect(r.outcome.health).toBe('REVIVED');
    expect(r.outcome.workspace?.changes()).toMatchObject([
      { path: 'rust-toolchain.toml', after: '[toolchain]\nchannel = "1.50"\n' },
    ]);
  });

  it('a failing build that no strategy can fix stays unrecoverable and keeps an empty patch', async () => {
    const r = await resurrect(RUST_FIXTURES.missingCrate, (v) =>
      v.label === 'build'
        ? {
            exitCode: 101,
            output:
              'error: failed to run custom build command for `openssl-sys v0.9.1`\nCould not find openssl',
          }
        : ok,
    );
    expect(r.outcome.health).not.toBe('REVIVED');
    expect(r.outcome.patch).toBe('');
    expect(r.outcome.report.coverage?.level).not.toBe('full');
  });
});
