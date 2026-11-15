import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertSafeCommand, shellSafe } from '@/engine/core/command';
import { computeCoverage } from '@/engine/core/coverage';
import {
  cacheEnvFor,
  imageFamily,
  isAllowedImage,
  isSafeEnvEntry,
  RUNTIME_FAMILIES,
} from '@/engine/core/images';
import type { StepName, StepResult } from '@/engine/core/types';
import { STEP_NAMES } from '@/engine/core/types';
import { DockerSandbox } from '@/sandbox/docker-sandbox';

describe('image allow-list', () => {
  it('accepts the approved runtimes', () => {
    for (const img of [
      'node:22',
      'python:3.11-slim',
      'rust:1.75-slim',
      'golang:1.22',
      'maven:3.9-eclipse-temurin-17',
    ])
      expect(isAllowedImage(img), img).toBe(true);
  });

  it('P: arbitrary strings are never allowed unless they match a rule', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        if (isAllowedImage(s)) expect(imageFamily(s)).not.toBeNull();
      }),
    );
    for (const bad of [
      'node:22 --privileged',
      'evil/node:22',
      'docker.io/library/node:22',
      'python:latest',
      'ubuntu:22.04',
      'node:22\n-v /:/host',
      'rust:1.75; rm -rf /',
      '',
    ])
      expect(isAllowedImage(bad), bad).toBe(false);
  });

  it('P: DockerSandbox refuses disallowed images when building run args', () => {
    const sb = new DockerSandbox({ jobId: 'j', memory: '1g', cpus: '1', pidsLimit: 64 });
    const spec = (image: string) => ({
      image,
      command: ['true'],
      workdir: process.platform === 'win32' ? 'C:\\w' : '/w',
      network: 'none' as const,
      timeoutMs: 1000,
      label: 'x',
    });
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((s) => !isAllowedImage(s)),
        (img) => {
          expect(() => sb.buildRunArgs(spec(img), 'n')).toThrow();
        },
      ),
    );
    const args = sb.buildRunArgs({ ...spec('python:3.11-slim'), cacheDir: '/c' }, 'n');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--read-only');
    expect(args).toContain('PIP_CACHE_DIR=/cache/pip');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it('cache env stays inside /cache and every family has one', () => {
    for (const f of RUNTIME_FAMILIES)
      for (const [k, v] of Object.entries(cacheEnvFor(f)))
        if (v.startsWith('/')) expect(v.startsWith('/cache'), `${f}:${k}`).toBe(true);
  });

  it('rejects secrets-looking env', () => {
    expect(isSafeEnvEntry('GITHUB_TOKEN', 'x')).toBe(false);
    expect(isSafeEnvEntry('DATABASE_URL', 'x')).toBe(false);
    expect(isSafeEnvEntry('CI', 'true')).toBe(true);
  });
});

describe('command validation', () => {
  it('rejects NUL and empty', () => {
    expect(() => assertSafeCommand([])).toThrow();
    expect(() => assertSafeCommand(['a\0b'])).toThrow();
    expect(assertSafeCommand(['npm', 'ci'])).toEqual(['npm', 'ci']);
  });
  it('shellSafe rejects metacharacters', () => {
    fc.assert(
      fc.property(fc.constantFrom(';', '|', '&', '$', '`', ' ', '"', "'", '\n', '>', '<', '(', ')'), (c) => {
        expect(() => shellSafe(`a${c}b`)).toThrow();
      }),
    );
  });
});

function step(
  name: StepName,
  status: StepResult['status'],
  skipReason?: StepResult['skipReason'],
): StepResult {
  return { step: name, status, skipReason, durationMs: 0, logTail: '' };
}

describe('verification coverage', () => {
  it('missing tests are never reported as full coverage', () => {
    const c = computeCoverage({
      steps: {
        install: step('install', 'passed'),
        build: step('build', 'passed'),
        test: step('test', 'skipped', 'no-test-suite'),
      },
    });
    expect(c.level).toBe('build-only');
    expect(c.testedFunctionally).toBe(false);
    expect(c.limitations.join(' ')).toMatch(/No automated test suite/);
  });

  it('P: full coverage requires a passing test step; failing steps are never full', () => {
    const statuses: StepResult['status'][] = ['passed', 'failed', 'timeout', 'skipped'];
    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.constantFrom(...statuses),
        fc.constantFrom(...statuses),
        (a, b, c) => {
          const steps = {
            install: step('install', a, a === 'skipped' ? 'blocked' : undefined),
            build: step('build', b, b === 'skipped' ? 'not-applicable' : undefined),
            test: step('test', c, c === 'skipped' ? 'no-test-suite' : undefined),
          };
          const cov = computeCoverage({ steps });
          if (cov.level === 'full') {
            expect(steps.test.status).toBe('passed');
            expect(
              STEP_NAMES.every((s) => steps[s].status !== 'failed' && steps[s].status !== 'timeout'),
            ).toBe(true);
          }
          if (STEP_NAMES.some((s) => steps[s].status === 'failed' || steps[s].status === 'timeout'))
            expect(cov.testedFunctionally).toBe(false);
        },
      ),
    );
  });
});
