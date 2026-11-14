/** Ecosystem-agnostic domain types shared across the engine. */

export const STEP_NAMES = ['install', 'build', 'test'] as const;
export type StepName = (typeof STEP_NAMES)[number];

/**
 * - passed / failed / timeout: the step ran.
 * - skipped: the step was not run. `skipReason` tells whether that is fine ("not-applicable",
 *   e.g. no build script, or "no-test-suite") or a failure ("blocked" by an earlier step).
 */
export type StepStatus = 'passed' | 'failed' | 'timeout' | 'skipped';
export type SkipReason = 'not-applicable' | 'no-test-suite' | 'blocked';

export interface StepResult {
  step: StepName;
  status: StepStatus;
  skipReason?: SkipReason;
  command?: string;
  exitCode?: number;
  durationMs: number;
  /** Tail of combined output, used for diagnosis and shown in the report. */
  logTail: string;
}

export interface VerificationResult {
  runtime: string;
  steps: Record<StepName, StepResult>;
  /** Issues diagnosed from this result (filled by the pipeline). */
  issues: Issue[];
  score: number;
}

export type IssueKind =
  | 'peer-conflict'
  | 'lockfile-drift'
  | 'git-protocol'
  | 'native-build'
  | 'node-sass'
  | 'engine-mismatch'
  | 'openssl-legacy'
  | 'modern-syntax'
  | 'missing-version'
  | 'unpublished-package'
  | 'missing-module'
  | 'missing-binary'
  | 'types-incompatible'
  | 'timeout'
  | 'network'
  | 'outdated-ci'
  | 'lifecycle-script-failure'
  | 'broken-upstream-resource'
  | 'missing-file'
  | 'missing-script'
  | 'lockfile-corrupt'
  | 'typescript-error'
  | 'dependency-api-change'
  | 'build-failure'
  | 'test-failure'
  | 'unknown';

export type Severity = 'critical' | 'error' | 'warning' | 'info';

/** Structured, machine-readable description of a failure. */
export interface IssueDiagnostic {
  category: string;
  message: string;
  command?: string;
  /** Repository-relative file most likely responsible (e.g. the failing script). */
  file?: string;
  /** npm lifecycle hook that failed, e.g. postinstall. */
  lifecycle?: string;
  /** Package that owns the failing script; differs from the project for dependency scripts. */
  package?: string;
  httpStatus?: number;
  resources?: string[];
}

export interface Issue {
  kind: IssueKind;
  /** Stable identity across runs, e.g. `missing-module:lodash`. */
  fingerprint: string;
  step: StepName | 'static';
  severity: Severity;
  title: string;
  /** Short log excerpt or file reference that triggered the issue. */
  evidence: string;
  /** Structured details for strategies (package name, required node range, file path...). */
  data?: Record<string, string>;
  /** Structured diagnosis (command, file, lifecycle hook, HTTP status) when the diagnoser could extract it. */
  diagnostic?: IssueDiagnostic;
}

/** `content: null` deletes the file. Paths are POSIX-style, relative to the repository root. */
export interface FileEdit {
  path: string;
  content: string | null;
}

export type FixKind = 'runtime' | 'static';

export interface FixProposal {
  strategyId: string;
  title: string;
  rationale: string;
  edits: FileEdit[];
  kind: FixKind;
}

export type AttemptStatus = 'VERIFIED' | 'VERIFIED_STATIC' | 'REVERTED' | 'SUGGESTED' | 'ERROR';

export interface AttemptRecord {
  seq: number;
  issueKind: IssueKind;
  fingerprint: string;
  strategyId: string;
  title: string;
  rationale: string;
  status: AttemptStatus;
  reason?: string;
  files: string[];
  diff?: string;
  verification?: Pick<VerificationResult, 'runtime' | 'score'> & {
    steps: Record<StepName, Pick<StepResult, 'status' | 'skipReason'>>;
  };
  durationMs: number;
}

export interface RuntimeSelection {
  /** Docker image tag, e.g. `node:16`. */
  image: string;
  /** Human label, e.g. `Node.js 16`. */
  label: string;
  major: number;
  source: string;
  warnings: string[];
}

export type JobStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'ANALYZING'
  | 'BASELINE'
  | 'DIAGNOSING'
  | 'REPAIRING'
  | 'VERIFYING'
  | 'REPORTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type Health = 'DEAD' | 'DIAGNOSING' | 'REPAIRING' | 'PARTIALLY_REVIVED' | 'REVIVED' | 'UNRECOVERABLE';

export type StageName = 'clone' | 'analyze' | 'baseline' | 'diagnose' | 'repair' | 'finalize' | 'report';
