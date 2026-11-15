import type { AttemptRecord, Health, JobStatus, StageName } from '@/engine/core/types';
import type { ProjectAnalysis } from '@/engine/ecosystems/types';
import type { ReportVerification, ResurrectionReport } from '@/engine/report';

export type { AttemptRecord, Health, JobStatus, StageName, ResurrectionReport };

/** Shape returned by GET /api/resurrections/:id. */
export interface JobSnapshot {
  id: string;
  repoUrl: string;
  owner: string;
  name: string;
  status: JobStatus;
  health: Health;
  heartbeat: number;
  currentStage: StageName | null;
  commitSha: string | null;
  commitDate: string | null;
  runtime: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: ResurrectionReport | null;
  attempts: AttemptRecord[];
  hasPatch: boolean;
  /** Detected ecosystem id (npm, python, rust...) and package manager; null for historic jobs. */
  ecosystem: string | null;
  packageManager: string | null;
  analysis: ProjectAnalysis | null;
  baseline: ReportVerification | null;
  publishMode: 'PATCH_ONLY' | 'REVIEW_PR' | 'AUTO_PR';
  /** True when the viewer owns the job (publication controls are shown only then). */
  owned: boolean;
}

export interface JobSummary {
  id: string;
  owner: string;
  name: string;
  status: JobStatus;
  health: Health;
  heartbeat: number;
  createdAt: string;
  finishedAt: string | null;
}

/** One SSE message. */
export interface ClientEvent {
  seq: number;
  type: 'stage' | 'status' | 'log' | 'heartbeat' | 'issue' | 'attempt' | 'done' | 'publication';
  level: string;
  message: string;
  data: Record<string, unknown> | null;
  ts: string;
}

export const JOB_ID_RE = /^[a-z0-9]{20,40}$/;
