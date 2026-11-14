import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Issue, StepResult } from '@/engine/core/types';
import { STEP_NAMES } from '@/engine/core/types';
import { decideAcceptance, scoreSteps, stepOk } from '@/engine/core/verification';
import { stepsArb } from '../helpers/arbitraries';

const issueArb = fc.constantFrom('a', 'b', 'c').map((fp): Issue => ({
  kind: 'unknown',
  fingerprint: fp,
  step: 'install',
  severity: 'error',
  title: fp,
  evidence: '',
}));

const r = (status: StepResult['status'], skipReason?: StepResult['skipReason']) =>
  ({ status, skipReason, durationMs: 0, logTail: '' }) as Omit<StepResult, 'step'>;

describe('decideAcceptance', () => {
  it('P4: an accepted fix never regresses a step that was ok', () => {
    fc.assert(
      fc.property(
        stepsArb,
        stepsArb,
        fc.array(issueArb),
        fc.array(issueArb),
        fc.constantFrom('a', 'b', 'c'),
        (ps, ns, pi, ni, target) => {
          const d = decideAcceptance({ steps: ps, issues: pi }, { steps: ns, issues: ni }, target);
          if (d.accept) {
            for (const s of STEP_NAMES) if (stepOk(ps[s])) expect(stepOk(ns[s])).toBe(true);
            expect(scoreSteps(ns)).toBeGreaterThanOrEqual(scoreSteps(ps));
          }
        },
      ),
    );
  });

  it('accepts when a failing step starts passing', () => {
    const prev = {
      steps: {
        install: { step: 'install', ...r('failed') },
        build: { step: 'build', ...r('skipped', 'blocked') },
        test: { step: 'test', ...r('skipped', 'blocked') },
      },
      issues: [],
    } as const;
    const next = {
      steps: {
        install: { step: 'install', ...r('passed') },
        build: { step: 'build', ...r('failed') },
        test: { step: 'test', ...r('passed') },
      },
      issues: [],
    } as const;
    expect(decideAcceptance(prev, next, 'x').accept).toBe(true);
  });

  it('rejects when the targeted issue is still present and nothing improved', () => {
    const steps = {
      install: { step: 'install', ...r('failed') },
      build: { step: 'build', ...r('skipped', 'blocked') },
      test: { step: 'test', ...r('skipped', 'blocked') },
    } as const;
    const issue: Issue = {
      kind: 'peer-conflict',
      fingerprint: 'peer-conflict',
      step: 'install',
      severity: 'error',
      title: '',
      evidence: '',
    };
    expect(
      decideAcceptance({ steps, issues: [issue] }, { steps, issues: [issue] }, 'peer-conflict').accept,
    ).toBe(false);
  });

  it('accepts progress: targeted issue gone, failure moved to a different problem in the same step', () => {
    const steps = {
      install: { step: 'install', ...r('failed') },
      build: { step: 'build', ...r('skipped', 'blocked') },
      test: { step: 'test', ...r('skipped', 'blocked') },
    } as const;
    const a: Issue = {
      kind: 'peer-conflict',
      fingerprint: 'peer-conflict',
      step: 'install',
      severity: 'error',
      title: '',
      evidence: '',
    };
    const b: Issue = { ...a, kind: 'node-sass', fingerprint: 'node-sass' };
    expect(decideAcceptance({ steps, issues: [a] }, { steps, issues: [b] }, 'peer-conflict').accept).toBe(
      true,
    );
  });
});
