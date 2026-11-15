import { createHash } from 'node:crypto';
import type { Issue, StepName } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import { walkFiles } from '../shared';
import type { Ecosystem, EcosystemDetection, StepPlan } from '../types';
import { analyzeRustProject, hasRustTests } from './analyze';
import { diagnoseCargoOutput } from './diagnose';
import { readRustProject } from './project';
import { selectRustRuntime } from './runtime';
import { rustStrategies } from './strategies';

/** Use the image's installed toolchain; repo toolchain files are honoured by selecting the image, not by downloading. */
const TOOLCHAIN = `export RUSTUP_TOOLCHAIN=$(rustup toolchain list | sed -n '1s/ .*//p')`;

const FINGERPRINT_FILES = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  '.cargo/config',
];

export async function detectRust(ws: Workspace): Promise<EcosystemDetection | null> {
  const p = await readRustProject(ws);
  if (!p.root)
    return p.manifests.length
      ? { confidence: 0.5, evidence: p.manifests.slice(0, 3).map((m) => m.path) }
      : null;
  const evidence = ['Cargo.toml'];
  let confidence = 0.85;
  if (p.lockfile) {
    evidence.push('Cargo.lock');
    confidence = 0.95;
  }
  if (p.channel) evidence.push(p.channel.source);
  if (p.workspaceMembers.length) evidence.push('workspace');
  return { confidence, evidence };
}

export const rustEcosystem: Ecosystem = {
  id: 'rust',
  displayName: 'Rust / Cargo',
  language: 'Rust',
  family: 'rust',
  supportsCiModernize: false,

  async detect(ws) {
    return ((await detectRust(ws))?.confidence ?? 0) >= 0.5;
  },
  detection: detectRust,

  sandboxEnv: () => ({
    CARGO_TERM_COLOR: 'never',
    CARGO_NET_RETRY: '3',
    RUST_BACKTRACE: '0',
    CARGO_INCREMENTAL: '0',
  }),

  analyze: analyzeRustProject,

  async selectRuntime(ws) {
    const p = await readRustProject(ws);
    return selectRustRuntime({ channel: p.channel, rustVersion: p.rustVersion, edition: p.edition });
  },

  async plan(ws, _runtime, timeouts: Record<StepName, number>): Promise<StepPlan[]> {
    const p = await readRustProject(ws);
    const locked = p.lockfile ? ' --locked' : '';
    const files = await walkFiles(ws);
    const tests = await hasRustTests(ws, files);
    return [
      {
        step: 'install',
        command: ['sh', '-c', `${TOOLCHAIN}; cargo fetch${locked}`],
        network: 'bridge',
        timeoutMs: timeouts.install,
      },
      {
        step: 'build',
        command: ['sh', '-c', `${TOOLCHAIN}; cargo check --workspace --all-targets --offline${locked}`],
        network: 'none',
        timeoutMs: timeouts.build,
      },
      tests
        ? {
            step: 'test',
            command: ['sh', '-c', `${TOOLCHAIN}; cargo test --workspace --offline${locked}`],
            network: 'none',
            timeoutMs: timeouts.test,
          }
        : { step: 'test', command: null, skipReason: 'no-test-suite', network: 'none', timeoutMs: 0 },
    ];
  },

  async installFingerprint(ws, runtime) {
    const h = createHash('sha256').update(runtime.image);
    for (const f of FINGERPRINT_FILES)
      h.update(`\0${f}\0${(await ws.current(f).catch(() => null)) ?? '<none>'}`);
    return h.digest('hex');
  },

  async diagnose(result) {
    return diagnoseCargoOutput({ result });
  },

  async staticIssues(): Promise<Issue[]> {
    return [];
  },

  warningsFromLogs(output) {
    return [
      ...new Set(
        [...output.matchAll(/warning: (?:package|crate) `([^`]+)`[^\n]*(?:yanked|deprecated)[^\n]*/gi)].map(
          (m) => m[0]!.slice(0, 160),
        ),
      ),
    ].slice(0, 10);
  },

  async lockfileRegeneration(ws) {
    return (await ws.exists('Cargo.lock')) || (await ws.exists('Cargo.toml'))
      ? { lockfile: 'Cargo.lock', command: ['sh', '-c', `${TOOLCHAIN}; cargo fetch`] }
      : null;
  },

  strategies: rustStrategies,
};
