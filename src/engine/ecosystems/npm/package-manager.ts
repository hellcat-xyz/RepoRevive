import { shellSafe } from '../../core/command';
import type { Workspace } from '../../core/workspace';

export type NodePackageManager = 'npm' | 'pnpm' | 'yarn';

export interface PackageManagerChoice {
  manager: NodePackageManager;
  /** Exact tool version to install into the cache, when determinable. */
  version: string | null;
  /** yarn >= 2 (Berry) behaves differently from Classic. */
  berry: boolean;
  source: string;
}

const DEFAULTS = { pnpm: '8.15.9', yarnClassic: '1.22.22', yarnBerry: '3.8.7' } as const;

/**
 * Choose the package manager from trustworthy metadata, in order:
 * 1. `packageManager` field (Corepack), 2. lockfile present, 3. npm.
 * When several lockfiles exist, npm wins only if its lockfile exists and no `packageManager` says otherwise.
 */
export async function detectPackageManager(ws: Workspace): Promise<PackageManagerChoice> {
  const pkgText = await ws.current('package.json').catch(() => null);
  let declared: string | null = null;
  try {
    const v = (JSON.parse(pkgText ?? '{}') as { packageManager?: unknown }).packageManager;
    declared = typeof v === 'string' ? v : null;
  } catch {
    declared = null;
  }
  const m = declared && /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:[+-].*)?$/.exec(declared);
  if (m) {
    const manager = m[1] as NodePackageManager;
    return {
      manager,
      version: m[2]!,
      berry: manager === 'yarn' && Number(m[2]!.split('.')[0]) >= 2,
      source: 'package.json#packageManager',
    };
  }
  if ((await ws.exists('package-lock.json')) || (await ws.exists('npm-shrinkwrap.json')))
    return { manager: 'npm', version: null, berry: false, source: 'package-lock.json' };
  if (await ws.exists('pnpm-lock.yaml')) {
    const lock = (await ws.current('pnpm-lock.yaml')) ?? '';
    const lv = /^lockfileVersion:\s*['"]?(\d+)(?:\.\d+)?/m.exec(lock)?.[1];
    const version = lv === '9' ? '9.12.3' : lv === '6' ? '8.15.9' : lv === '5' ? '7.33.7' : DEFAULTS.pnpm;
    return { manager: 'pnpm', version, berry: false, source: 'pnpm-lock.yaml' };
  }
  if (await ws.exists('yarn.lock')) {
    const lock = (await ws.current('yarn.lock')) ?? '';
    const berry = /^__metadata:/m.test(lock);
    return {
      manager: 'yarn',
      version: berry ? DEFAULTS.yarnBerry : DEFAULTS.yarnClassic,
      berry,
      source: 'yarn.lock',
    };
  }
  return { manager: 'npm', version: null, berry: false, source: 'default' };
}

const PM_DIR = '/cache/pm';

/** Install command (network) for a non-npm manager. The tool is installed into the job cache, never the image. */
export function installCommand(c: PackageManagerChoice): string[] | null {
  if (c.manager === 'npm' || !c.version) return null;
  const v = shellSafe(c.version);
  const flags = '--no-audit --no-fund --no-update-notifier --loglevel=error';
  if (c.manager === 'pnpm')
    return [
      'sh',
      '-c',
      `npm install --prefix ${PM_DIR} ${flags} pnpm@${v} && ${PM_DIR}/node_modules/.bin/pnpm install --frozen-lockfile`,
    ];
  if (c.berry)
    return [
      'sh',
      '-c',
      `npm install --prefix ${PM_DIR} ${flags} @yarnpkg/cli-dist@${v} && node ${PM_DIR}/node_modules/@yarnpkg/cli-dist/bin/yarn.js install --immutable`,
    ];
  return [
    'sh',
    '-c',
    `npm install --prefix ${PM_DIR} ${flags} yarn@${v} && ${PM_DIR}/node_modules/.bin/yarn install --frozen-lockfile`,
  ];
}

/** Run a package script with the chosen manager. */
export function runScriptCommand(c: PackageManagerChoice, script: 'build' | 'test'): string[] {
  if (c.manager === 'pnpm') return ['sh', '-c', `${PM_DIR}/node_modules/.bin/pnpm run ${script}`];
  if (c.manager === 'yarn')
    return c.berry
      ? ['sh', '-c', `node ${PM_DIR}/node_modules/@yarnpkg/cli-dist/bin/yarn.js run ${script}`]
      : ['sh', '-c', `${PM_DIR}/node_modules/.bin/yarn run ${script}`];
  return script === 'build' ? ['npm', 'run', 'build'] : ['npm', 'test'];
}

export const PM_ENV = {
  npm_config_store_dir: '/cache/pnpm-store',
  YARN_ENABLE_TELEMETRY: '0',
  YARN_CACHE_FOLDER: '/cache/yarn',
};
