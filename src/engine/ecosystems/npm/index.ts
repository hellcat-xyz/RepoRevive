import { createHash } from 'node:crypto';
import type { Issue, StepName } from '../../core/types';
import type { Ecosystem, StepPlan } from '../types';
import { analyzeNpmProject, readRuntimeDeclarations } from './analyze';
import { deprecationWarnings, diagnoseNpmOutput, gitProtocolUsages } from './diagnose';
import { dependenciesOf, isPlaceholderTest, readManifest, scriptsOf } from './manifest';
import { detectPackageManager, installCommand, PM_ENV, runScriptCommand } from './package-manager';
import { selectNodeRuntime } from './runtime';
import { npmStrategies } from './strategies';

const INSTALL_INPUTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.yarnrc.yml',
];
export const NODE_SANDBOX_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_loglevel: 'warn',
  ADBLOCK: '1',
  DISABLE_OPENCOLLECTIVE: '1',
  HUSKY: '0',
  PUPPETEER_SKIP_DOWNLOAD: '1',
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
  CYPRESS_INSTALL_BINARY: '0',
  BROWSERSLIST_IGNORE_OLD_DATA: '1',
};
const COMMON_FLAGS = ['--no-audit', '--no-fund', '--no-update-notifier'];

async function npmLockfile(ws: Parameters<Ecosystem['detect']>[0]): Promise<string | null> {
  if (await ws.exists('npm-shrinkwrap.json')) return 'npm-shrinkwrap.json';
  if (await ws.exists('package-lock.json')) return 'package-lock.json';
  return null;
}

export const npmEcosystem: Ecosystem = {
  id: 'npm',
  displayName: 'Node.js / npm',
  language: 'Node.js',
  family: 'node',
  supportsCiModernize: true,

  sandboxEnv: () => ({ ...NODE_SANDBOX_ENV, ...PM_ENV }),

  async detection(ws) {
    const m = await readManifest(ws);
    if (!m) return null;
    const evidence = ['package.json'];
    let confidence = 0.55;
    if (await npmLockfile(ws)) {
      evidence.push('npm lockfile');
      confidence = 0.95;
    } else if (scriptsOf(m.json).build || scriptsOf(m.json).test) {
      evidence.push('build/test scripts');
      confidence = 0.8;
    }
    return { confidence, evidence };
  },

  async detect(ws) {
    return (await ws.read('package.json').catch(() => null)) !== null;
  },

  analyze: analyzeNpmProject,

  async selectRuntime(ws) {
    return selectNodeRuntime(await readRuntimeDeclarations(ws));
  },

  async plan(ws, _runtime, timeouts: Record<StepName, number>): Promise<StepPlan[]> {
    const m = await readManifest(ws);
    const scripts = m ? scriptsOf(m.json) : {};
    const lock = await npmLockfile(ws);
    const pm = await detectPackageManager(ws);
    const install =
      installCommand(pm) ??
      (lock
        ? ['npm', 'ci', ...COMMON_FLAGS]
        : // No lockfile: install fresh without writing one, so the working tree only changes via verified fixes.
          ['sh', '-c', `rm -rf node_modules && npm install --no-package-lock ${COMMON_FLAGS.join(' ')}`]);
    return [
      { step: 'install', command: install, network: 'bridge', timeoutMs: timeouts.install },
      scripts.build?.trim()
        ? {
            step: 'build',
            command: runScriptCommand(pm, 'build'),
            network: 'none',
            timeoutMs: timeouts.build,
          }
        : { step: 'build', command: null, skipReason: 'not-applicable', network: 'none', timeoutMs: 0 },
      !isPlaceholderTest(scripts.test)
        ? { step: 'test', command: runScriptCommand(pm, 'test'), network: 'none', timeoutMs: timeouts.test }
        : { step: 'test', command: null, skipReason: 'no-test-suite', network: 'none', timeoutMs: 0 },
    ];
  },

  async installFingerprint(ws, runtime) {
    const h = createHash('sha256').update(runtime.image);
    for (const f of INSTALL_INPUTS)
      h.update(`\0${f}\0${(await ws.current(f).catch(() => null)) ?? '<none>'}`);
    return h.digest('hex');
  },

  async diagnose(result, ctx) {
    const m = await readManifest(ctx.ws);
    const declared = new Set(m ? dependenciesOf(m.json).map((d) => d.name) : []);
    return diagnoseNpmOutput({
      step: result.step,
      result,
      declaredDeps: declared,
      runtimeMajor: ctx.runtime.major,
      projectName: typeof m?.json.name === 'string' ? m.json.name : null,
      scripts: m ? scriptsOf(m.json) : {},
    });
  },

  async staticIssues(ws) {
    const issues: Issue[] = [];
    let usages = 0;
    for (const f of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      const raw = await ws.current(f).catch(() => null);
      if (raw) usages += gitProtocolUsages(raw);
    }
    if (usages > 0) {
      issues.push({
        kind: 'git-protocol',
        fingerprint: 'git-protocol',
        step: 'install',
        severity: 'error',
        title: 'Dependencies use git:// or SSH URLs that cannot be fetched anonymously',
        evidence: `${usages} git dependency URL(s) use git:// or ssh:// in package.json / lockfile.`,
      });
    }
    return issues;
  },

  warningsFromLogs: deprecationWarnings,

  async lockfileRegeneration(ws) {
    const lock = await npmLockfile(ws);
    if (!lock) return null;
    return {
      lockfile: lock,
      command: ['npm', 'install', '--package-lock-only', '--ignore-scripts', ...COMMON_FLAGS],
    };
  },

  strategies: npmStrategies,
};
