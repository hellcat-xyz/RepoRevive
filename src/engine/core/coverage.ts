import type { StepName, StepResult, VerificationResult } from './types';
import { STEP_NAMES } from './types';

export type StepCoverage = 'passed' | 'failed' | 'not-applicable' | 'no-test-suite' | 'blocked';

/**
 * - full: install passed, build passed or not applicable, and a test suite ran and passed.
 * - build-only: install and build ok but no test suite exists (functional behaviour is unverified).
 * - install-only: only installation was exercised.
 * - failing: a step that ran failed.
 * - blocked: an earlier step prevented later ones from running.
 * - none: nothing could be verified.
 */
export type CoverageLevel = 'full' | 'build-only' | 'install-only' | 'failing' | 'blocked' | 'none';

export interface VerificationCoverage {
  steps: Record<StepName, StepCoverage>;
  level: CoverageLevel;
  /** Human-readable limitations; always shown next to a REVIVED result. */
  limitations: string[];
  /** True only for `full`: a passing test suite exercised the code. */
  testedFunctionally: boolean;
}

function stepCoverage(r: Pick<StepResult, 'status' | 'skipReason'>): StepCoverage {
  if (r.status === 'passed') return 'passed';
  if (r.status === 'skipped') {
    if (r.skipReason === 'blocked') return 'blocked';
    if (r.skipReason === 'no-test-suite') return 'no-test-suite';
    return 'not-applicable';
  }
  return 'failed';
}

export function computeCoverage(v: Pick<VerificationResult, 'steps'> | null): VerificationCoverage {
  if (!v) {
    return {
      steps: { install: 'blocked', build: 'blocked', test: 'blocked' },
      level: 'none',
      limitations: ['No verification result is available.'],
      testedFunctionally: false,
    };
  }
  const steps = Object.fromEntries(STEP_NAMES.map((s) => [s, stepCoverage(v.steps[s])])) as Record<
    StepName,
    StepCoverage
  >;
  const limitations: string[] = [];
  let level: CoverageLevel;
  if (STEP_NAMES.some((s) => steps[s] === 'failed')) level = 'failing';
  else if (STEP_NAMES.some((s) => steps[s] === 'blocked')) level = 'blocked';
  else if (steps.test === 'passed') level = 'full';
  else if (steps.build === 'passed') level = 'build-only';
  else if (steps.install === 'passed') level = 'install-only';
  else level = 'none';

  if (steps.test === 'no-test-suite')
    limitations.push('No automated test suite was found, so behaviour was not tested.');
  if (steps.build === 'not-applicable')
    limitations.push('The project has no build/compile step that could be checked.');
  if (level === 'install-only') limitations.push('Only dependency installation was verified.');
  if (level === 'failing') limitations.push('At least one verification step still fails.');
  if (level === 'blocked') limitations.push('A failed step blocked later steps from running.');
  return { steps, level, limitations, testedFunctionally: level === 'full' };
}
