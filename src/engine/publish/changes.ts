import { validateRelativePath } from '../core/workspace';

/** One accepted file change. `before`/`after` are full text; null means absent. */
export interface PublishChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755';
  /** Present for additions/modifications. */
  content?: string;
  /** `null` deletes the path. */
  sha?: null;
}

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 5_000_000;

export type PublishErrorCode =
  | 'EMPTY_PATCH'
  | 'UNSUPPORTED_CHANGE'
  | 'DRIFT'
  | 'CONFLICT'
  | 'POLICY'
  | 'FORBIDDEN'
  | 'AUTH_EXPIRED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'SERVER';

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message: string,
    /** Whether a later retry can succeed without the user changing anything. */
    readonly retryable = false,
    /** Server-provided wait (rate limits), in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

export interface ExcludedChange {
  path: string;
  reason: string;
}

/** Workflow files need the `workflows` permission and a human review; they stay in the downloadable patch only. */
export function isWorkflowPath(p: string): boolean {
  return /^\.github\/workflows\//.test(p);
}

export interface PartitionedChanges {
  publishable: PublishChange[];
  excluded: ExcludedChange[];
}

/**
 * Split accepted changes into publishable and excluded, and reject anything that cannot be published
 * faithfully (unsafe path, binary, oversize, count). Throws `PublishError` rather than skipping silently.
 */
export function partitionChanges(changes: readonly PublishChange[]): PartitionedChanges {
  const publishable: PublishChange[] = [];
  const excluded: ExcludedChange[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const c of changes) {
    try {
      const segs = validateRelativePath(c.path);
      if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s)))
        throw new PublishError('UNSUPPORTED_CHANGE', `Refusing to publish ${c.path}`);
    } catch (err) {
      if (err instanceof PublishError) throw err;
      throw new PublishError('UNSUPPORTED_CHANGE', `Unsafe path "${c.path}"`);
    }
    if (seen.has(c.path)) throw new PublishError('UNSUPPORTED_CHANGE', `Duplicate change for ${c.path}`);
    seen.add(c.path);
    if (c.before === c.after) continue; // no-op
    for (const text of [c.before, c.after]) {
      if (text !== null && text.includes('\0'))
        throw new PublishError(
          'UNSUPPORTED_CHANGE',
          `${c.path} looks binary; only text changes can be published.`,
        );
    }
    if (c.after !== null) {
      const bytes = Buffer.byteLength(c.after, 'utf8');
      if (bytes > MAX_FILE_BYTES)
        throw new PublishError('UNSUPPORTED_CHANGE', `${c.path} is too large to publish (${bytes} bytes).`);
      total += bytes;
    }
    if (isWorkflowPath(c.path)) {
      excluded.push({
        path: c.path,
        reason: 'Workflow files are never published automatically; apply the patch manually after review.',
      });
      continue;
    }
    publishable.push(c);
  }
  if (publishable.length > MAX_FILES)
    throw new PublishError('UNSUPPORTED_CHANGE', `Too many files (${publishable.length}).`);
  if (total > MAX_TOTAL_BYTES)
    throw new PublishError('UNSUPPORTED_CHANGE', 'The change set is too large to publish.');
  return { publishable, excluded };
}

/**
 * Convert changes into Git Data tree entries. `modes` maps existing paths to their current git mode;
 * symlinks and submodules are rejected so they are never silently converted to regular files.
 */
export function toTreeEntries(
  changes: readonly PublishChange[],
  modes: ReadonlyMap<string, string>,
): TreeEntry[] {
  return changes.map((c) => {
    const existing = modes.get(c.path);
    if (existing === '120000' || existing === '160000' || existing === '040000')
      throw new PublishError(
        'UNSUPPORTED_CHANGE',
        `${c.path} is a symlink, submodule or directory in the base tree.`,
      );
    if (c.after === null) return { path: c.path, mode: '100644', sha: null };
    return { path: c.path, mode: existing === '100755' ? '100755' : '100644', content: c.after };
  });
}

/** Normalised view of what a set of tree entries will do, used to prove published == accepted. */
export function describeEntries(entries: readonly TreeEntry[]): Record<string, string | null> {
  return Object.fromEntries(entries.map((e) => [e.path, e.sha === null ? null : (e.content ?? '')]));
}
