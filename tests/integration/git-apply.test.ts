import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitPatch } from '@/engine/core/patch';
import type { FileChange } from '@/engine/core/workspace';

/**
 * Integration: patches must be accepted by real `git apply`. The repository here is created by the
 * test from generated, trusted content, so running host git is safe (unlike cloned repositories).
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const lineArb = fc.stringMatching(/^[a-zA-Z0-9 _.:{}"]{0,16}$/);
const textArb = fc
  .tuple(fc.array(lineArb, { maxLength: 15 }), fc.boolean())
  .map(([ls, nl]) => (ls.length ? ls.join('\n') + (nl ? '\n' : '') : ''));
const changeSetArb = fc
  .uniqueArray(
    fc.constantFrom(
      'package.json',
      '.nvmrc',
      '.npmrc',
      'src/index.js',
      '.github/workflows/ci.yml',
      'lib/a/b.ts',
    ),
    { minLength: 1, maxLength: 4 },
  )
  .chain((paths) =>
    fc.tuple(
      ...paths.map((p) =>
        fc.record({
          path: fc.constant(p),
          before: fc.option(textArb, { nil: null }),
          after: fc.option(textArb, { nil: null }),
        }),
      ),
    ),
  );

describe.runIf(hasGit())('git apply compatibility', () => {
  it('P2 (integration): git apply reproduces the final tree', async () => {
    await fc.assert(
      fc.asyncProperty(changeSetArb, async (changes: FileChange[]) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-git-'));
        try {
          const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], {
              cwd: dir,
              stdio: 'pipe',
            });
          git('init', '-q');
          for (const c of changes) {
            if (c.before === null) continue;
            await fs.mkdir(path.dirname(path.join(dir, c.path)), { recursive: true });
            await fs.writeFile(path.join(dir, c.path), c.before);
          }
          const patch = createGitPatch(changes);
          if (!patch) return;
          await fs.writeFile(path.join(dir, 'fix.patch'), patch);
          git('apply', '--check', 'fix.patch');
          git('apply', 'fix.patch');
          for (const c of changes) {
            const p = path.join(dir, c.path);
            if (c.after === null) await expect(fs.access(p)).rejects.toThrow();
            else expect(await fs.readFile(p, 'utf8')).toBe(c.after);
          }
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
