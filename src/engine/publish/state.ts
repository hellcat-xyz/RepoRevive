/** Publication state machine. Kept separate from the repair job status (engine/core/state.ts). */
export const PUBLICATION_STATUSES = [
  'NOT_REQUESTED',
  'PENDING_APPROVAL',
  'QUEUED',
  'AUTHORIZING',
  'PREPARING_BRANCH',
  'PUBLISHING_COMMIT',
  'CREATING_PR',
  'CREATED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'AUTH_EXPIRED',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

const ACTIVE: PublicationStatus[] = ['AUTHORIZING', 'PREPARING_BRANCH', 'PUBLISHING_COMMIT', 'CREATING_PR'];
const FAIL_EXITS: PublicationStatus[] = ['FAILED', 'BLOCKED', 'CANCELLED', 'AUTH_EXPIRED'];

export const TRANSITIONS: Record<PublicationStatus, readonly PublicationStatus[]> = {
  NOT_REQUESTED: ['PENDING_APPROVAL', 'QUEUED'],
  PENDING_APPROVAL: ['QUEUED', 'CANCELLED'],
  QUEUED: ['AUTHORIZING', 'CANCELLED'],
  // AUTHORIZING -> CREATED only reconciles a pull request created by an earlier, crashed run.
  AUTHORIZING: ['PREPARING_BRANCH', 'CREATED', ...FAIL_EXITS],
  PREPARING_BRANCH: ['PUBLISHING_COMMIT', 'CREATING_PR', ...FAIL_EXITS],
  PUBLISHING_COMMIT: ['CREATING_PR', ...FAIL_EXITS],
  CREATING_PR: ['CREATED', ...FAIL_EXITS],
  CREATED: [],
  // Retryable terminals go back to the queue (a user action or bounded automatic retry).
  FAILED: ['QUEUED', 'CANCELLED'],
  AUTH_EXPIRED: ['QUEUED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export class InvalidPublicationTransition extends Error {
  constructor(
    readonly from: PublicationStatus,
    readonly to: PublicationStatus,
  ) {
    super(`Invalid publication transition ${from} -> ${to}`);
    this.name = 'InvalidPublicationTransition';
  }
}

export function canTransition(from: PublicationStatus, to: PublicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PublicationStatus, to: PublicationStatus): void {
  if (!canTransition(from, to)) throw new InvalidPublicationTransition(from, to);
}

export const isActive = (s: PublicationStatus): boolean => ACTIVE.includes(s);
/** Nothing further will happen without a user action. */
export const isTerminal = (s: PublicationStatus): boolean =>
  s === 'CREATED' || s === 'CANCELLED' || s === 'FAILED' || s === 'BLOCKED' || s === 'AUTH_EXPIRED';
/** The user may press "retry" in these states. BLOCKED is retryable only after the cause (drift, permission) changes. */
export const isRetryable = (s: PublicationStatus): boolean =>
  s === 'FAILED' || s === 'AUTH_EXPIRED' || s === 'BLOCKED';

export const MAX_PUBLISH_ATTEMPTS = 5;
