import type { Workspace } from '../core/workspace';
import type { ProjectAnalysis } from './types';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  'dist',
  'build',
  '.tox',
  '.idea',
  '.next',
]);
export const WALK_MAX_FILES = 5000;
const MAX_DEPTH = 6;

/** Breadth-first listing of repository files (bounded). Paths are POSIX-relative. */
export async function walkFiles(ws: Workspace, maxFiles = WALK_MAX_FILES): Promise<string[]> {
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];
  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift()!;
    for (const entry of await ws.list(dir).catch(() => [])) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) queue.push({ dir: rel, depth: depth + 1 });
      } else {
        files.push(rel);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

export function languageCounts(files: string[], exts: string[]): ProjectAnalysis['languages'] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = f.includes('.') ? f.slice(f.lastIndexOf('.') + 1).toLowerCase() : '';
    if (exts.includes(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([extension, n]) => ({ extension, files: n }))
    .sort((a, b) => b.files - a.files);
}

export async function listWorkflows(ws: Workspace): Promise<string[]> {
  const entries = await ws.list('.github/workflows').catch(() => []);
  return entries
    .filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name))
    .map((e) => `.github/workflows/${e.name}`);
}
