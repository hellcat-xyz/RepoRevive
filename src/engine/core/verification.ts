import type { Health, Issue, StepName, StepResult, VerificationResult } from './types';
import { STEP_NAMES } from './types';

export const STEP_WEIGHTS: Record<StepName, number> = { install: 40, build: 30, test: 30 };

/** A step counts as "ok" if it passed or legitimately did not apply. */
export function stepOk(r: StepResult): boolean {
  if (r.status === 'passed') return true;
  return r.status === 'skipped' && r.skipReason !== 'blocked';
}

export function scoreSteps(steps: Record<StepName, StepResult>): number {
  let score = 0;
  for (const s of STEP_NAMES) if (stepOk(steps[s])) score += STEP_WEIGHTS[s];
  return score;
}

export function allStepsOk(v: Pick<VerificationResult, 'steps'>): boolean {
  return STEP_NAMES.every((s) => stepOk(v.steps[s]));
}

/** Index of the first step that is not ok, or STEP_NAMES.length when all are ok. */
export function firstFailingIndex(v: Pick<VerificationResult, 'steps'>): number {
  const i = STEP_NAMES.findIndex((s) => !stepOk(v.steps[s]));
  return i === -1 ? STEP_NAMES.length : i;
}

export interface AcceptanceDecision {
  accept: boolean;
  reason: string;
}

/**
 * Decide whether a fix is kept. Invariant (property P4): if accepted, no step that was ok before
 * is not ok after.
 */
export function decideAcceptance(
  prev: Pick<VerificationResult, 'steps'> & { issues: readonly Issue[] },
  next: Pick<VerificationResult, 'steps'> & { issues: readonly Issue[] },
  targetedFingerprint: string,
): AcceptanceDecision {
  for (const s of STEP_NAMES) {
    if (stepOk(prev.steps[s]) && !stepOk(next.steps[s])) {
      return { accept: false, reason: `Regression: ${s} was passing and now ${describe(next.steps[s])}.` };
    }
  }
  const improved = STEP_NAMES.filter((s) => !stepOk(prev.steps[s]) && stepOk(next.steps[s]));
  if (improved.length > 0) {
    return { accept: true, reason: `Now passing: ${improved.join(', ')}.` };
  }
  const stillPresent = next.issues.some((i) => i.fingerprint === targetedFingerprint);
  if (!stillPresent && firstFailingIndex(next) >= firstFailingIndex(prev)) {
    const step = STEP_NAMES[firstFailingIndex(next)] ?? 'all steps';
    return {
      accept: true,
      reason: `Targeted issue resolved; the remaining failure is a different problem in ${step}.`,
    };
  }
  return {
    accept: false,
    reason: stillPresent ? 'The targeted issue still occurs.' : 'No measurable improvement.',
  };
}

function describe(r: StepResult): string {
  return r.status === 'skipped' ? `skipped (${r.skipReason ?? 'unknown'})` : r.status;
}

/** Final health. Property P6: REVIVED iff every step is ok in the final verification. */
export function computeHealth(
  baseline: Pick<VerificationResult, 'steps'> | null,
  final: Pick<VerificationResult, 'steps'> | null,
): Health {
  if (!final) return 'UNRECOVERABLE';
  if (allStepsOk(final)) return 'REVIVED';
  if (baseline && scoreSteps(final.steps) > scoreSteps(baseline.steps)) return 'PARTIALLY_REVIVED';
  return 'UNRECOVERABLE';
}

export function summarizeSteps(steps: Record<StepName, StepResult>) {
  return Object.fromEntries(
    STEP_NAMES.map((s) => [s, { status: steps[s].status, skipReason: steps[s].skipReason }]),
  ) as Record<StepName, Pick<StepResult, 'status' | 'skipReason'>>;
}

export function uniqueIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.fingerprint) ? false : (seen.add(i.fingerprint), true)));
}
