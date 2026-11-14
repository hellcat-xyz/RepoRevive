import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canTransition, InvalidTransitionError, isTerminal, JobStateMachine } from '@/engine/core/state';
import type { JobStatus } from '@/engine/core/types';
import { stepsArb } from '../helpers/arbitraries';
import { allStepsOk, computeHealth } from '@/engine/core/verification';

const STATUSES: JobStatus[] = [
  'QUEUED',
  'CLONING',
  'ANALYZING',
  'BASELINE',
  'DIAGNOSING',
  'REPAIRING',
  'VERIFYING',
  'REPORTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];
const HAPPY_PATH: JobStatus[] = [
  'CLONING',
  'ANALYZING',
  'BASELINE',
  'DIAGNOSING',
  'REPAIRING',
  'VERIFYING',
  'REPAIRING',
  'VERIFYING',
  'REPORTING',
  'COMPLETED',
];

describe('job state machine', () => {
  it('accepts the happy path', () => {
    const sm = new JobStateMachine();
    for (const s of HAPPY_PATH) sm.transition(s);
    expect(sm.status).toBe('COMPLETED');
  });

  it('P3: any sequence of attempted transitions only ever follows allowed edges, and terminal states are absorbing', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...STATUSES), { maxLength: 40 }), (targets) => {
        const sm = new JobStateMachine();
        let reachedTerminal = false;
        for (const t of targets) {
          const from = sm.status;
          const allowed = canTransition(from, t);
          if (allowed) {
            expect(reachedTerminal).toBe(false);
            sm.transition(t);
            expect(sm.status).toBe(t);
          } else {
            expect(() => sm.transition(t)).toThrow(InvalidTransitionError);
            expect(sm.status).toBe(from);
          }
          if (isTerminal(sm.status)) reachedTerminal = true;
        }
      }),
    );
  });

  it('FAILED and CANCELLED are reachable from every non-terminal state', () => {
    for (const s of STATUSES.filter((x) => !isTerminal(x))) {
      expect(canTransition(s, 'FAILED')).toBe(true);
      expect(canTransition(s, 'CANCELLED')).toBe(true);
    }
  });
});

describe('computeHealth', () => {
  it('P6: REVIVED iff every step is ok in the final result; never PARTIALLY_REVIVED without improvement', () => {
    fc.assert(
      fc.property(stepsArb, stepsArb, (b, f) => {
        const h = computeHealth({ steps: b }, { steps: f });
        expect(h === 'REVIVED').toBe(allStepsOk({ steps: f }));
        if (h === 'PARTIALLY_REVIVED') expect(allStepsOk({ steps: f })).toBe(false);
      }),
    );
  });

  it('is UNRECOVERABLE without a final result', () => {
    expect(computeHealth(null, null)).toBe('UNRECOVERABLE');
  });
});
