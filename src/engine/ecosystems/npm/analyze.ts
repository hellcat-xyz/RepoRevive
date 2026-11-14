import type { Workspace } from '../../core/workspace';
import type { ProjectAnalysis } from '../types';
import type { RuntimeDeclaration } from './runtime';
import {
  dependenciesOf,
  enginesNode,
  isPlaceholderTest,
  readManifest,
  scriptsOf,
  voltaNode,
} from './manifest';

export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'bower_components',
  'dist',
  'build',
  'coverage',
  '.next',
  'vendor',
]);
const MAX_FILES = 20_000;
const MAX_DEPTH = 12;

const FRAMEWORK_HINTS: [string, string][] = [
  ['next', 'Next.js'],
  ['react-scripts', 'Create React App'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['@angular/core', 'Angular'],
  ['svelte', 'Svelte'],
  ['express', 'Express'],
  ['koa', 'Koa'],
  ['electron', 'Electron'],
  ['webpack', 'webpack'],
  ['vite', 'Vite'],
  ['gulp', 'gulp'],
  ['grunt', 'Grunt'],
  ['typescript', 'TypeScript'],
  ['node-sass', 'node-sass'],
];

const TEST_FRAMEWORKS = ['jest', 'mocha', 'vitest', 'ava', 'jasmine', 'karma', 'tap', 'tape', 'uvu', 'qunit'];

export async function readRuntimeDeclarations(ws: Workspace): Promise<RuntimeDeclaration[]> {
  const out: RuntimeDeclaration[] = [];
  for (const file of ['.nvmrc', '.node-version']) {
    const raw = await ws.current(file).catch(() => null);
    const first = raw
      ?.split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .find(Boolean);
    if (first) out.push({ source: file, value: first });
  }
  const m = await readManifest(ws);
  if (m) {
    const volta = voltaNode(m.json);
    if (volta) out.push({ source: 'package.json#volta.node', value: volta });
    const engines = enginesNode(m.json);
    if (engines) out.push({ source: 'package.json#engines.node', value: engines });
  }
  return out;
}

async function walk(ws: Workspace): Promise<string[]> {
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];
  while (queue.length && files.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    for (const entry of await ws.list(dir).catch(() => [])) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) queue.push({ dir: rel, depth: depth + 1 });
      } else {
        files.push(rel);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

function extensionOf(file: string): string | null {
  const base = file.split('/').pop() ?? file;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : null;
}

export async function analyzeNpmProject(ws: Workspace): Promise<ProjectAnalysis> {
  const manifest = await readManifest(ws);
  const warnings: string[] = [];
  if (!manifest) warnings.push('package.json is missing or is not valid JSON.');
  const json = manifest?.json ?? {};
  const scripts = scriptsOf(json);
  const dependencies = dependenciesOf(json);
  const depNames = new Set(dependencies.map((d) => d.name));

  const lockfiles: string[] = [];
  for (const l of LOCKFILES) if (await ws.exists(l)) lockfiles.push(l);

  let lockfileVersion: number | null = null;
  const npmLock = lockfiles.find((l) => l === 'package-lock.json' || l === 'npm-shrinkwrap.json');
  if (npmLock) {
    try {
      const lock = JSON.parse((await ws.read(npmLock)) ?? '{}') as { lockfileVersion?: unknown };
      lockfileVersion = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 1;
    } catch {
      warnings.push(`${npmLock} is not valid JSON.`);
    }
  } else if (lockfiles.length > 0) {
    warnings.push(
      `Only ${lockfiles.join(', ')} found. RepoRevive MVP installs with npm, so versions may differ.`,
    );
  }

  const files = await walk(ws);
  if (files.length >= MAX_FILES)
    warnings.push(`Repository has more than ${MAX_FILES} files; analysis was truncated.`);
  const extCounts = new Map<string, number>();
  for (const f of files) {
    const ext = extensionOf(f);
    if (
      ext &&
      [
        'js',
        'mjs',
        'cjs',
        'jsx',
        'ts',
        'tsx',
        'vue',
        'svelte',
        'coffee',
        'json',
        'css',
        'scss',
        'less',
      ].includes(ext)
    ) {
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
  }
  const languages = [...extCounts.entries()]
    .map(([extension, n]) => ({ extension, files: n }))
    .sort((a, b) => b.files - a.files);

  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const testFramework =
    TEST_FRAMEWORKS.find((t) => depNames.has(t) || (scripts.test ?? '').includes(t)) ??
    (depNames.has('react-scripts') ? 'jest (react-scripts)' : null);
  const isMonorepo =
    json.workspaces !== undefined || files.includes('lerna.json') || files.includes('pnpm-workspace.yaml');
  if (isMonorepo)
    warnings.push('Monorepo/workspaces detected. Only the root package is verified in the MVP.');

  return {
    ecosystem: 'npm',
    packageManager: 'npm',
    projectName: typeof json.name === 'string' ? json.name : null,
    description: typeof json.description === 'string' ? json.description.slice(0, 300) : null,
    dependencies,
    scripts,
    lockfiles,
    lockfileVersion,
    runtimeDeclarations: await readRuntimeDeclarations(ws),
    hasBuild: Boolean(scripts.build?.trim()),
    hasTests: !isPlaceholderTest(scripts.test),
    testFramework,
    frameworks: FRAMEWORK_HINTS.filter(([dep]) => depNames.has(dep)).map(([, label]) => label),
    languages,
    fileCount: files.length,
    workflows,
    isMonorepo,
    warnings,
  };
}
