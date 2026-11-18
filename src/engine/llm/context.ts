import path from 'node:path';
import type { Issue } from '../core/types';
import type { StrategyContext } from '../ecosystems/types';
import { walkFiles } from '../ecosystems/shared';
import { isAllowedLlmPath } from './paths';

export const MAX_CONTEXT_FILES = 10;
export const MAX_FILE_BYTES = 16_000;
export const MAX_CONTEXT_BYTES = 64_000;
export const MAX_TREE_PATHS = 250;

/** Manifest files shown to the model, per ecosystem. */
export const MANIFESTS: Record<string, string[]> = {
  npm: ['package.json'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
  rust: ['Cargo.toml', 'rust-toolchain.toml'],
  go: ['go.mod'],
  maven: ['pom.xml'],
};

const SOURCE_EXT = 'js|jsx|mjs|cjs|ts|tsx|vue|json|scss|css|py|rs|go|java|kt';

/** Repository paths mentioned in a stack trace or compiler output. */
export function referencedFiles(log: string, max = MAX_CONTEXT_FILES): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `(?:\\/workspace\\/|(?:^|[\\s(\\["']))((?:[\\w@.-]+\\/)*[\\w@.-]+\\.(?:${SOURCE_EXT}))(?=[:(\\s)\\]"',]|$)`,
    'gm',
  );
  for (const m of log.matchAll(re)) {
    const p = m[1]!.replace(/^\.\//, '');
    if (!p.includes('node_modules') && isAllowedLlmPath(p) && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const JS_EXT = [
  '',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '/index.js',
  '/index.ts',
  '/index.tsx',
];

/** Candidate repository paths for the local imports of a file (one level, no resolution against disk). */
export function localImports(file: string, content: string): string[] {
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  const out: string[] = [];
  const add = (p: string) => {
    const n = path.posix.normalize(p);
    if (!n.startsWith('..') && !out.includes(n)) out.push(n);
  };
  if (/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) {
    for (const m of content.matchAll(
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g,
    )) {
      const base = path.posix.join(dir, m[1]!);
      for (const ext of JS_EXT) add(base + ext);
    }
  } else if (file.endsWith('.py')) {
    for (const m of content.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\b/gm)) {
      const up = m[1]!.length - 1;
      let base = dir;
      for (let i = 0; i < up; i++) base = path.posix.dirname(base) === '.' ? '' : path.posix.dirname(base);
      const rel = m[2]!.replace(/\./g, '/');
      if (rel) {
        add(path.posix.join(base, `${rel}.py`));
        add(path.posix.join(base, rel, '__init__.py'));
      }
    }
    for (const m of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w]*(?:\.[\w]+)*)/gm)) {
      const rel = m[1]!.replace(/\./g, '/');
      add(`${rel}.py`);
      add(`${rel}/__init__.py`);
      if (dir) add(path.posix.join(dir, `${rel}.py`));
    }
  }
  return out;
}

export interface LlmContext {
  files: { path: string; content: string }[];
  tree: string[];
}

/** Files and layout shown to the model for one issue. Everything goes through the workspace's path checks. */
export async function buildLlmContext(
  ctx: Pick<StrategyContext, 'ws' | 'ecosystem'>,
  issue: Issue,
  log: string,
): Promise<LlmContext> {
  const files: { path: string; content: string }[] = [];
  let total = 0;
  const add = async (p: string): Promise<boolean> => {
    if (files.length >= MAX_CONTEXT_FILES || files.some((f) => f.path === p) || !isAllowedLlmPath(p))
      return false;
    const content = await ctx.ws.current(p).catch(() => null);
    if (content === null || content.length > MAX_FILE_BYTES || total + content.length > MAX_CONTEXT_BYTES)
      return false;
    files.push({ path: p, content });
    total += content.length;
    return true;
  };

  for (const m of MANIFESTS[ctx.ecosystem?.id ?? 'npm'] ?? MANIFESTS.npm!) await add(m);
  const primary = [issue.diagnostic?.file, ...referencedFiles(log)].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  for (const p of primary) await add(p);
  // One level of local imports from the files the failure points at.
  for (const f of files.filter((x) => primary.includes(x.path))) {
    for (const imp of localImports(f.path, f.content)) {
      if (files.length >= MAX_CONTEXT_FILES) break;
      await add(imp);
    }
  }

  const tree = (await walkFiles(ctx.ws, 1500).catch(() => []))
    .filter((p) => isAllowedLlmPath(p))
    .sort()
    .slice(0, MAX_TREE_PATHS);
  return { files, tree };
}
