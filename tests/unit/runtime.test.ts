import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  eraNodeMajor,
  maxNodeForNodeSass,
  resolveNodeDeclaration,
  selectNodeRuntime,
  SUPPORTED_NODE_MAJORS,
} from '@/engine/ecosystems/npm/runtime';

describe('Node runtime selection', () => {
  it.each([
    ['v12.18.3', 12],
    ['12', 12],
    ['14.x', 14],
    ['>=8', 22],
    ['^10.13.0 || ^12', 12],
    ['>=0.10.0', 22],
    ['lts/gallium', 16],
    ['lts/*', 22],
    ['node', 22],
    ['16.20.2', 16],
  ])('resolves %s to %i', (value, major) => {
    expect(resolveNodeDeclaration(value)?.major).toBe(major);
  });

  it('maps unsupported versions to the nearest supported major with a warning', () => {
    const r = resolveNodeDeclaration('6.11.0');
    expect(r?.major).toBe(8);
    expect(r?.warning).toMatch(/not available/);
    expect(resolveNodeDeclaration('15')).toMatchObject({ major: 16 });
    expect(resolveNodeDeclaration('lts/boron')?.major).toBe(8);
  });

  it('respects declaration priority and skips unusable values', () => {
    const r = selectNodeRuntime([
      { source: '.nvmrc', value: 'something weird' },
      { source: 'package.json#engines.node', value: '^14' },
    ]);
    expect(r.major).toBe(14);
    expect(r.image).toBe('node:14');
    expect(r.warnings.length).toBe(1);
    expect(selectNodeRuntime([]).major).toBe(22);
  });

  it('always yields a supported image for arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ source: fc.constant('x'), value: fc.string({ maxLength: 20 }) }), {
          maxLength: 3,
        }),
        (decls) => {
          const r = selectNodeRuntime(decls);
          expect((SUPPORTED_NODE_MAJORS as readonly number[]).includes(r.major)).toBe(true);
          expect(r.image).toBe(`node:${r.major}`);
        },
      ),
    );
  });

  it('infers era Node from commit dates', () => {
    expect(eraNodeMajor('2016-05-01T00:00:00Z')).toBe(8);
    expect(eraNodeMajor('2019-06-01T00:00:00Z')).toBe(10);
    expect(eraNodeMajor('2021-01-01T00:00:00Z')).toBe(14);
    expect(eraNodeMajor('2023-11-01T00:00:00Z')).toBe(20);
    expect(eraNodeMajor(null)).toBe(22);
  });

  it('knows which Node versions each node-sass release supports', () => {
    expect(maxNodeForNodeSass('^4.14.1')).toBe(14);
    expect(maxNodeForNodeSass('4.12.0')).toBe(12);
    expect(maxNodeForNodeSass('^7.0.1')).toBe(17);
    expect(maxNodeForNodeSass('~4.9.0')).toBe(10);
  });
});
