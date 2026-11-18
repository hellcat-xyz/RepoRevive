import type { Health } from './types';

/** Folders never searched for sub-projects (dependencies, build output, virtualenvs, caches). */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  'env',
  '__pycache__',
  'coverage',
  'bower_components',
  'third_party',
]);

/**
 * Conventional full-stack folder names. When the root is itself a project (for example an Express
 * server with a `client/` React app next to it), only these depth-1 folders are added as companions.
 */
export const COMPANION_DIRS: ReadonlySet<string> = new Set([
  'client',
  'frontend',
  'front-end',
  'server',
  'backend',
  'back-end',
  'api',
  'web',
  'ui',
  'app',
  'website',
  'admin',
]);

export const DEFAULT_MAX_SUBPROJECTS = 4;
export const MAX_SEARCH_DEPTH = 2;
/** Upper bound on folders inspected during discovery, so a huge tree cannot stall the job. */
export const MAX_FOLDERS_EXAMINED = 200;

export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name.toLowerCase());
}

export interface OrchestratorFacts {
  hasWorkspaces: boolean;
  hasLockfile: boolean;
  hasBuildScript: boolean;
  hasRealTestScript: boolean;
}

/**
 * A root `package.json` that only wires other folders together (`concurrently`, `install-all`):
 * no workspaces, no lockfile, nothing to build, nothing to test.
 */
export function isOrchestratorRoot(f: OrchestratorFacts): boolean {
  return !f.hasWorkspaces && !f.hasLockfile && !f.hasBuildScript && !f.hasRealTestScript;
}

/** Deterministic order: the root ("") first, then by folder path (code-unit order). */
export function compareFolders(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  return a < b ? -1 : 1;
}

export function limitProjects<T extends { folder: string }>(
  items: readonly T[],
  max: number,
): { kept: T[]; dropped: T[] } {
  const sorted = [...items].sort((x, y) => compareFolders(x.folder, y.folder));
  const cap = Math.max(1, Math.floor(max));
  return { kept: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

/** Re-base a project-relative path onto the repository root. */
export function prefixPath(folder: string, rel: string): string {
  return folder === '' ? rel : `${folder}/${rel}`;
}

export interface ProjectHealth {
  health: Health;
  /** False when the project was never run (cap or time budget). */
  ran: boolean;
}

/**
 * Job health from per-project results.
 * REVIVED only if every project ran and is REVIVED; PARTIALLY_REVIVED if at least one project
 * is REVIVED or PARTIALLY_REVIVED; UNRECOVERABLE otherwise.
 */
export function aggregateHealth(results: readonly ProjectHealth[]): Health {
  if (results.length === 0) return 'UNRECOVERABLE';
  if (results.every((r) => r.ran && r.health === 'REVIVED')) return 'REVIVED';
  if (results.some((r) => r.ran && (r.health === 'REVIVED' || r.health === 'PARTIALLY_REVIVED')))
    return 'PARTIALLY_REVIVED';
  return 'UNRECOVERABLE';
}
