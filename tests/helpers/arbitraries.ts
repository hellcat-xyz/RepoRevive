import fc from 'fast-check';
import type { StepName, StepResult } from '@/engine/core/types';
import { STEP_NAMES } from '@/engine/core/types';

export const stepArb = (step: StepName): fc.Arbitrary<StepResult> =>
  fc.oneof(
    fc.constant<StepResult>({ step, status: 'passed', durationMs: 1, logTail: '' }),
    fc.constant<StepResult>({ step, status: 'failed', durationMs: 1, logTail: '' }),
    fc.constant<StepResult>({ step, status: 'timeout', durationMs: 1, logTail: '' }),
    fc
      .constantFrom<NonNullable<StepResult['skipReason']>>('blocked', 'not-applicable', 'no-test-suite')
      .map((skipReason): StepResult => ({ step, status: 'skipped', skipReason, durationMs: 0, logTail: '' })),
  );

export const stepsArb = fc.record(
  Object.fromEntries(STEP_NAMES.map((s) => [s, stepArb(s)])) as Record<StepName, fc.Arbitrary<StepResult>>,
);

/** Safe relative POSIX paths (1-3 segments). */
export const relPathArb = fc
  .array(fc.stringMatching(/^[a-z0-9_-]{1,8}(\.[a-z]{1,4})?$/), { minLength: 1, maxLength: 3 })
  .map((segs) => segs.join('/'));

/** File content including tricky cases: empty, CRLF, no trailing newline, unicode. */
export const contentArb = fc.oneof(
  fc.constant(''),
  fc.array(fc.stringMatching(/^[^\r\n]{0,30}$/), { maxLength: 12 }).map((ls) => ls.join('\n')),
  fc.array(fc.stringMatching(/^[^\r\n]{0,30}$/), { maxLength: 12 }).map((ls) => ls.join('\n') + '\n'),
  fc.array(fc.stringMatching(/^[a-z ]{0,20}$/), { maxLength: 8 }).map((ls) => ls.join('\r\n') + '\r\n'),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
);
