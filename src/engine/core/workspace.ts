import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ResurrectionError } from './errors';
import type { FileEdit } from './types';

export const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface Snapshot {
  /** Prior state of each touched path, in edit order (first occurrence only). */
  entries: { path: string; before: string | null; expectedBefore: boolean }[];
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * Validate a repository-relative POSIX path. Rejects absolute paths, drive letters, backslashes,
 * empty / "." / ".." segments and NUL bytes. Returns normalized segments.
 */
export function validateRelativePath(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024)
    throw unsafe(rel, 'empty or too long');
  if (rel.includes('\0')) throw unsafe(rel, 'NUL byte');
  if (rel.includes('\\')) throw unsafe(rel, 'backslash');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw unsafe(rel, 'absolute path');
  const segments = rel.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw unsafe(rel, 'invalid segment');
  }
  return segments;
}

function unsafe(rel: string, why: string) {
  return new ResurrectionError('UNSAFE_PATH', `Refusing unsafe path "${String(rel).slice(0, 200)}": ${why}`);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Host-side view of a cloned repository. The repository content is untrusted: sandboxed scripts may
 * have planted symlinks, so every access checks each path component with lstat.
 *
 * Tracks two maps for touched files:
 * - `originals`: content at first touch (what the upstream commit contains),
 * - `expected`: content the engine intends the file to have now.
 * Command side effects on tracked files are undone with `restoreTracked()`.
 */
export class Workspace {
  private readonly originals = new Map<string, string | null>();
  private readonly expected = new Map<string, string | null>();

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<Workspace> {
    const real = await fs.realpath(root);
    const st = await fs.lstat(real);
    if (!st.isDirectory())
      throw new ResurrectionError('INTERNAL', `Workspace root is not a directory: ${root}`);
    return new Workspace(real);
  }

  /** Resolve to an absolute host path, refusing symlinks on any existing component. */
  async resolve(rel: string): Promise<string> {
    const segments = validateRelativePath(rel);
    let current = this.root;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]!);
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink()) throw unsafe(rel, 'symlink in path');
        if (i < segments.length - 1 && !st.isDirectory()) throw unsafe(rel, 'non-directory parent');
      } catch (err) {
        if (isNotFound(err)) {
          // Remaining components do not exist yet; nothing more to check.
          return path.join(this.root, ...segments);
        }
        throw err;
      }
    }
    return current;
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.lstat(await this.resolve(rel));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Returns file content or null if it does not exist. Directories and oversized files throw. */
  async read(rel: string, maxBytes = MAX_READ_BYTES): Promise<string | null> {
    const abs = await this.resolve(rel);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    if (!st.isFile()) throw unsafe(rel, 'not a regular file');
    if (st.size > maxBytes) throw unsafe(rel, `file larger than ${maxBytes} bytes`);
    return fs.readFile(abs, 'utf8');
  }

  /** Lists regular files and directories (no symlinks) directly under `relDir` ("" for root). */
  async list(relDir = ''): Promise<{ name: string; type: 'file' | 'dir' }[]> {
    const abs = relDir === '' ? this.root : await this.resolve(relDir);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async writeRaw(rel: string, content: string | null): Promise<void> {
    const abs = await this.resolve(rel);
    if (content === null) {
      await fs.rm(abs, { force: true });
      return;
    }
    const segments = validateRelativePath(rel);
    if (segments.length > 1) {
      // Create parents one level at a time so each new directory is checked as well.
      for (let i = 1; i < segments.length; i++) {
        const dirRel = segments.slice(0, i).join('/');
        const dirAbs = await this.resolve(dirRel);
        await fs.mkdir(dirAbs, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
      }
    }
    await this.resolve(rel); // re-check after creating parents
    await fs.writeFile(abs, content, 'utf8');
  }

  /** Apply edits, returning a snapshot that restores the exact prior state. */
  async applyEdits(edits: FileEdit[]): Promise<Snapshot> {
    const snapshot: Snapshot = { entries: [] };
    const seen = new Set<string>();
    for (const e of edits) validateRelativePath(e.path);
    for (const e of edits) {
      if (!seen.has(e.path)) {
        seen.add(e.path);
        const before = this.expected.has(e.path) ? this.expected.get(e.path)! : await this.read(e.path);
        snapshot.entries.push({ path: e.path, before, expectedBefore: this.expected.has(e.path) });
        if (!this.originals.has(e.path)) this.originals.set(e.path, before);
      }
      await this.writeRaw(e.path, e.content);
      this.expected.set(e.path, e.content);
    }
    return snapshot;
  }

  /** Restore every path in the snapshot to its prior content (deleting files the edits created). */
  async rollback(snapshot: Snapshot): Promise<void> {
    for (const entry of [...snapshot.entries].reverse()) {
      await this.writeRaw(entry.path, entry.before);
      if (entry.expectedBefore) {
        this.expected.set(entry.path, entry.before);
      } else {
        // First touched by this snapshot: forget it entirely.
        this.expected.delete(entry.path);
        this.originals.delete(entry.path);
      }
    }
  }

  /** Undo side effects that commands (e.g. `npm install`) had on files the engine tracks. */
  async restoreTracked(): Promise<void> {
    for (const [rel, content] of this.expected) {
      const current = await this.read(rel).catch(() => undefined);
      if (current !== content) await this.writeRaw(rel, content);
    }
  }

  /** The content the engine expects for a path (tracked edits first, then disk). */
  async current(rel: string): Promise<string | null> {
    return this.expected.has(rel) ? this.expected.get(rel)! : this.read(rel);
  }

  /** Net changes relative to the original commit, for patch generation. */
  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [p, before] of this.originals) {
      const after = this.expected.has(p) ? this.expected.get(p)! : before;
      if (before !== after) out.push({ path: p, before, after });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}
