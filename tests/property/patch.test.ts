import { applyPatch, parsePatch } from 'diff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFilePatch, createGitPatch, patchStats } from '@/engine/core/patch';
import type { FileChange } from '@/engine/core/workspace';
import { contentArb } from '../helpers/arbitraries';

const lineArb = fc.stringMatching(/^[a-z{}":, ]{0,12}$/);
/** Mostly-similar before/after pairs so hunks have context, plus arbitrary pairs. */
const pairArb = fc.oneof(
  fc.tuple(contentArb, contentArb),
  fc
    .tuple(
      fc.array(lineArb, { minLength: 1, maxLength: 30 }),
      fc.array(fc.tuple(fc.nat(30), lineArb), { maxLength: 4 }),
      fc.boolean(),
    )
    .map(([lines, muts, nl]) => {
      const after = [...lines];
      for (const [i, l] of muts) after.splice(i % (after.length + 1), 0, l);
      const end = nl ? '\n' : '';
      return [lines.join('\n') + end, after.join('\n') + end] as [string, string];
    }),
);

describe('createFilePatch', () => {
  it('P2: applying the patch to the original reproduces the final content', () => {
    fc.assert(
      fc.property(pairArb, ([before, after]) => {
        const patch = createFilePatch({ path: 'src/file.txt', before, after });
        if (before === after) {
          expect(patch).toBe('');
          return;
        }
        expect(patch.startsWith('diff --git a/src/file.txt b/src/file.txt\n')).toBe(true);
        const [parsed] = parsePatch(patch);
        if (!parsed || parsed.hunks.length === 0) {
          expect(before === '' || after === '').toBe(true);
          return;
        }
        expect(applyPatch(before, parsed)).toBe(after);
      }),
      { numRuns: 300 },
    );
  });

  it('marks new and deleted files like git does', () => {
    const added = createFilePatch({ path: '.nvmrc', before: null, after: '16\n' });
    expect(added).toBe(
      'diff --git a/.nvmrc b/.nvmrc\nnew file mode 100644\n--- /dev/null\n+++ b/.nvmrc\n@@ -0,0 +1,1 @@\n+16\n',
    );
    const deleted = createFilePatch({ path: 'x.js', before: 'a\n', after: null });
    expect(deleted).toContain('deleted file mode 100644\n--- a/x.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n');
  });

  it('refuses paths git would need to quote', () => {
    expect(() => createFilePatch({ path: 'has space.js', before: 'a', after: 'b' })).toThrow();
    expect(() => createFilePatch({ path: '../escape', before: 'a', after: 'b' })).toThrow();
  });

  it('multi-file patches are ordered and counted', () => {
    const changes: FileChange[] = [
      { path: 'package.json', before: '{\n  "a": 1\n}\n', after: '{\n  "a": 2\n}\n' },
      { path: '.npmrc', before: null, after: 'legacy-peer-deps=true\n' },
    ];
    const patch = createGitPatch(changes);
    expect(patch.indexOf('a/.npmrc')).toBeLessThan(patch.indexOf('a/package.json'));
    expect(patchStats(patch)).toEqual({ files: 2, additions: 2, deletions: 1 });
  });
});
