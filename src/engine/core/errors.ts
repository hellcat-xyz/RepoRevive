export type ErrorCode =
  | 'INVALID_URL'
  | 'REPO_NOT_FOUND_OR_PRIVATE'
  | 'REPO_TOO_LARGE'
  | 'CLONE_FAILED'
  | 'NETWORK_ERROR'
  | 'NOT_A_NODE_PROJECT'
  | 'DOCKER_UNAVAILABLE'
  | 'JOB_TIMEOUT'
  | 'WORKER_INTERRUPTED'
  | 'CANCELLED'
  | 'UNSAFE_PATH'
  | 'INTERNAL';

export class ResurrectionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResurrectionError';
  }
}

export function toResurrectionError(err: unknown): ResurrectionError {
  if (err instanceof ResurrectionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ResurrectionError('INTERNAL', message, err);
}
