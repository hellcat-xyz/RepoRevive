import { structuredPatch } from 'diff';
import { ResurrectionError } from './errors';
import type { FileChange } from './workspace';

/** Paths that git prints without quoting. Anything else is refused so headers stay unambiguous. */
export const PATCHABLE_PATH_RE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export function isPatchablePath(p: string): boolean {
  return PATCHABLE_PATH_RE.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
}

/** Unified diff for a single file in `git diff` format. Returns '' when there is no change. */
export function createFilePatch(change: FileChange, context = 3): string {
  const { path: p, before, after } = change;
  if (before === after) return '';
  if (!isPatchablePath(p))
    throw new ResurrectionError('UNSAFE_PATH', `Cannot create a patch for path "${p}"`);

  const header = [`diff --git a/${p} b/${p}`];
  if (before === null) header.push('new file mode 100644');
  if (after === null) header.push('deleted file mode 100644');

  const sp = structuredPatch(`a/${p}`, `b/${p}`, before ?? '', after ?? '', undefined, undefined, {
    context,
  });
  if (sp.hunks.length === 0) {
    // e.g. creating or deleting an empty file: git emits only the header.
    return header.join('\n') + '\n';
  }

  const out = [
    ...header,
    `--- ${before === null ? '/dev/null' : `a/${p}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${p}`}`,
  ];
  for (const h of sp.hunks) {
    const oldStart = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
    const newStart = h.newLines === 0 ? h.newStart - 1 : h.newStart;
    out.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join('\n') + '\n';
}

/** A complete multi-file patch, ordered by path, suitable for `git apply`. */
export function createGitPatch(changes: FileChange[], context = 3): string {
  return [...changes]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((c) => createFilePatch(c, context))
    .join('');
}

export interface PatchStats {
  files: number;
  additions: number;
  deletions: number;
}

export function patchStats(patch: string): PatchStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++ ')) additions++;
    else if (line.startsWith('-') && !line.startsWith('--- ')) deletions++;
  }
  return { files, additions, deletions };
}
