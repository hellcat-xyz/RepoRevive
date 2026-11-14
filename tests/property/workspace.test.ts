import fc from 'fast-check';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileEdit } from '@/engine/core/types';
import { validateRelativePath, Workspace } from '@/engine/core/workspace';
import { contentArb, relPathArb } from '../helpers/arbitraries';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-ws-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Read every regular file under root into a map (relative POSIX path -> content). */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string) {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out.set(r, await fs.readFile(path.join(root, r), 'utf8'));
    }
  }
  await walk('');
  return out;
}

/** Paths must not collide as file vs directory (a/b as a file and a/b/c). */
function consistentPaths(paths: string[]): boolean {
  return paths.every((p) => !paths.some((q) => q !== p && q.startsWith(p + '/')));
}

const initialArb = fc.dictionary(relPathArb, contentArb, { maxKeys: 5 });
const editsArb = fc.array(
  fc.record({ path: relPathArb, content: fc.option(contentArb, { nil: null }) }) as fc.Arbitrary<FileEdit>,
  { minLength: 1, maxLength: 6 },
);

describe('Workspace', () => {
  it('P1: rollback(apply(edits)) restores byte-identical files, including deletions and creations', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, editsArb, async (initial, edits) => {
        fc.pre(consistentPaths([...Object.keys(initial), ...edits.map((e) => e.path)]));
        const root = await tmp();
        for (const [p, c] of Object.entries(initial)) {
          await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
          await fs.writeFile(path.join(root, p), c, 'utf8');
        }
        const before = await snapshotTree(root);
        const ws = await Workspace.open(root);
        const snap = await ws.applyEdits(edits);
        await ws.rollback(snap);
        const after = await snapshotTree(root);
        expect(after).toEqual(before);
        expect(ws.changes()).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('nested snapshots roll back independently (inner first, outer kept)', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, editsArb, editsArb, async (initial, e1, e2) => {
        fc.pre(
          consistentPaths([...Object.keys(initial), ...e1.map((e) => e.path), ...e2.map((e) => e.path)]),
        );
        const root = await tmp();
        for (const [p, c] of Object.entries(initial)) {
          await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
          await fs.writeFile(path.join(root, p), c, 'utf8');
        }
        const ws = await Workspace.open(root);
        await ws.applyEdits(e1);
        const afterFirst = await snapshotTree(root);
        const changesAfterFirst = ws.changes();
        const s2 = await ws.applyEdits(e2);
        await ws.rollback(s2);
        expect(await snapshotTree(root)).toEqual(afterFirst);
        expect(ws.changes()).toEqual(changesAfterFirst);
      }),
      { numRuns: 40 },
    );
  });

  it('restoreTracked undoes command side effects on tracked files only', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'package.json'), '{"a":1}\n');
    const ws = await Workspace.open(root);
    await ws.applyEdits([{ path: 'package.json', content: '{"a":2}\n' }]);
    await fs.writeFile(path.join(root, 'package.json'), 'clobbered');
    await fs.writeFile(path.join(root, 'build.log'), 'side effect');
    await ws.restoreTracked();
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('{"a":2}\n');
    expect(await fs.readFile(path.join(root, 'build.log'), 'utf8')).toBe('side effect');
  });

  it.each(['/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'C:/x', 'a\\b', 'a\0b', ''])(
    'rejects unsafe path %j',
    (p) => {
      expect(() => validateRelativePath(p)).toThrow();
    },
  );

  it('refuses to read or write through symlinks planted by sandboxed code', async () => {
    const root = await tmp();
    const outside = await tmp();
    await fs.writeFile(path.join(outside, 'secret'), 'host secret');
    try {
      await fs.symlink(path.join(outside, 'secret'), path.join(root, 'package.json'));
      await fs.symlink(outside, path.join(root, 'linkdir'), 'junction');
    } catch {
      return; // symlinks need privileges on some Windows setups; nothing to test then
    }
    const ws = await Workspace.open(root);
    await expect(ws.read('package.json')).rejects.toThrow(/symlink/);
    await expect(ws.applyEdits([{ path: 'linkdir/secret', content: 'pwned' }])).rejects.toThrow(/symlink/);
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('host secret');
  });
});
