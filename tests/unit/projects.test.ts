import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateHealth,
  compareFolders,
  isOrchestratorRoot,
  isSkippedDir,
  limitProjects,
  prefixPath,
} from '@/engine/core/projects';
import type { Health } from '@/engine/core/types';

const HEALTHS: Health[] = [
  'DEAD',
  'DIAGNOSING',
  'REPAIRING',
  'PARTIALLY_REVIVED',
  'REVIVED',
  'UNRECOVERABLE',
];
const health = fc.constantFrom(...HEALTHS);
const folder = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), { minLength: 1, maxLength: 2 })
  .map((p) => p.join('/'));

describe('multi-project helpers', () => {
  it('detects orchestrator roots only when there is nothing to build, test or lock', () => {
    const base = {
      hasWorkspaces: false,
      hasLockfile: false,
      hasBuildScript: false,
      hasRealTestScript: false,
    };
    expect(isOrchestratorRoot(base)).toBe(true);
    for (const k of Object.keys(base) as (keyof typeof base)[])
      expect(isOrchestratorRoot({ ...base, [k]: true })).toBe(false);
  });

  it('skips dependency, build-output and hidden folders', () => {
    for (const n of [
      'node_modules',
      'vendor',
      'dist',
      'build',
      'target',
      'venv',
      '.git',
      '.github',
      'Coverage',
    ])
      expect(isSkippedDir(n)).toBe(true);
    for (const n of ['client', 'server', 'packages', 'apps']) expect(isSkippedDir(n)).toBe(false);
  });

  it('prefixes project paths onto the repository root', () => {
    expect(prefixPath('', 'package.json')).toBe('package.json');
    expect(prefixPath('client', 'package.json')).toBe('client/package.json');
    expect(prefixPath('apps/web', 'src/a.ts')).toBe('apps/web/src/a.ts');
  });

  it('P: limitProjects is deterministic, capped, keeps the root first and partitions the input', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.oneof(folder, fc.constant('')), { maxLength: 15 }),
        fc.integer({ min: 1, max: 10 }),
        (folders, max) => {
          const items = folders.map((f) => ({ folder: f }));
          const a = limitProjects(items, max);
          const b = limitProjects([...items].reverse(), max);
          expect(a).toEqual(b);
          expect(a.kept.length).toBeLessThanOrEqual(max);
          expect(a.kept.length + a.dropped.length).toBe(items.length);
          if (folders.includes('')) expect(a.kept[0]?.folder).toBe('');
          const order = [...a.kept, ...a.dropped].map((x) => x.folder);
          expect(order).toEqual([...order].sort(compareFolders));
        },
      ),
    );
  });

  it('P: aggregateHealth is REVIVED iff every project ran and is REVIVED', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ health, ran: fc.boolean() }), { maxLength: 8 }), (results) => {
        const h = aggregateHealth(results);
        const allRevived = results.length > 0 && results.every((r) => r.ran && r.health === 'REVIVED');
        expect(h === 'REVIVED').toBe(allRevived);
        const anyGood = results.some(
          (r) => r.ran && (r.health === 'REVIVED' || r.health === 'PARTIALLY_REVIVED'),
        );
        if (!allRevived) expect(h).toBe(anyGood ? 'PARTIALLY_REVIVED' : 'UNRECOVERABLE');
      }),
    );
  });

  it('an unrun project can never be hidden behind revived ones', () => {
    expect(
      aggregateHealth([
        { health: 'REVIVED', ran: true },
        { health: 'UNRECOVERABLE', ran: false },
      ]),
    ).toBe('PARTIALLY_REVIVED');
  });
});
