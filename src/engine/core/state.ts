import type { Health, JobStatus } from './types';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const FLOW: Record<JobStatus, JobStatus[]> = {
  QUEUED: ['CLONING'],
  CLONING: ['ANALYZING'],
  // Non-Node projects go straight to reporting.
  ANALYZING: ['BASELINE', 'REPORTING'],
  BASELINE: ['DIAGNOSING'],
  // Nothing to repair -> report directly.
  DIAGNOSING: ['REPAIRING', 'VERIFYING', 'REPORTING'],
  REPAIRING: ['VERIFYING'],
  VERIFYING: ['REPAIRING', 'REPORTING'],
  REPORTING: ['COMPLETED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (isTerminal(from)) return false;
  if (to === 'FAILED' || to === 'CANCELLED') return true;
  return FLOW[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Invalid job status transition ${from} -> ${to}`);
  }
}

/** Small state holder used by the pipeline so every status change is validated. */
export class JobStateMachine {
  private current: JobStatus;
  constructor(initial: JobStatus = 'QUEUED') {
    this.current = initial;
  }
  get status(): JobStatus {
    return this.current;
  }
  transition(to: JobStatus): JobStatus {
    if (!canTransition(this.current, to)) throw new InvalidTransitionError(this.current, to);
    this.current = to;
    return to;
  }
}

/** Health shown while a job is running, derived from status. Final health comes from `computeHealth`. */
export function healthForStatus(status: JobStatus): Health {
  switch (status) {
    case 'QUEUED':
    case 'CLONING':
      return 'DEAD';
    case 'ANALYZING':
    case 'BASELINE':
    case 'DIAGNOSING':
      return 'DIAGNOSING';
    case 'REPAIRING':
    case 'VERIFYING':
    case 'REPORTING':
      return 'REPAIRING';
    case 'FAILED':
    case 'CANCELLED':
      return 'UNRECOVERABLE';
    case 'COMPLETED':
      return 'REVIVED';
  }
}
