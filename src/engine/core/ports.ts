import type { AttemptRecord, Health, Issue, JobStatus, StageName } from './types';

// ---------- Sandbox ----------

export interface RunSpec {
  image: string;
  /** argv executed inside the container. The engine only passes fixed templates here. */
  command: string[];
  /** Host path of the repository (mounted at /workspace). */
  workdir: string;
  /** Host path of the per-job package cache (mounted at /cache). */
  cacheDir?: string;
  network: 'none' | 'bridge';
  timeoutMs: number;
  env?: Record<string, string>;
  /** Short label for logs and container names, e.g. "install". */
  label: string;
}

export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined stdout/stderr (bounded). */
  output: string;
}

export type OutputListener = (line: string, stream: 'stdout' | 'stderr') => void;

export interface Sandbox {
  ensureImage(image: string, onLine?: OutputListener): Promise<void>;
  run(spec: RunSpec, onLine?: OutputListener): Promise<RunResult>;
  /** Remove a workspace whose files may be owned by the sandbox user. */
  removeDir(hostDir: string): Promise<void>;
}

// ---------- Package registry ----------

export interface Packument {
  name: string;
  versions: string[];
  /** version -> ISO publish time */
  time: Record<string, string>;
  distTags: Record<string, string>;
  /** version -> declared bin names */
  bins?: Record<string, string[]>;
}

export interface PackageRegistry {
  packument(name: string): Promise<Packument | null>;
}

// ---------- LLM ----------

export interface LlmFixRequest {
  step: string;
  issueTitle: string;
  logExcerpt: string;
  files: { path: string; content: string }[];
  runtime: string;
}

export interface LlmClient {
  /** Returns raw model output; callers must validate it. */
  proposeEdits(req: LlmFixRequest): Promise<unknown>;
}

// ---------- Events ----------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export type PipelineEvent =
  | { type: 'stage'; stage: StageName; message: string }
  | { type: 'status'; status: JobStatus; health: Health; message: string }
  | { type: 'log'; level: LogLevel; message: string; source?: string }
  | { type: 'heartbeat'; value: number; message: string }
  | { type: 'issue'; issue: Issue; message: string }
  | { type: 'attempt'; attempt: AttemptRecord; message: string }
  | { type: 'done'; health: Health; message: string };

export interface EventSink {
  emit(event: PipelineEvent): void;
  flush?(): Promise<void>;
}

export class MemoryEventSink implements EventSink {
  readonly events: PipelineEvent[] = [];
  emit(event: PipelineEvent): void {
    this.events.push(event);
  }
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
