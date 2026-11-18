import type { RuntimeFamily } from '../core/images';
import type { LlmClient, PackageRegistry, UpstreamResolver } from '../core/ports';
import type {
  FileEdit,
  FixProposal,
  Issue,
  IssueKind,
  RuntimeSelection,
  SkipReason,
  StepName,
  StepResult,
  VerificationResult,
} from '../core/types';
import type { Workspace } from '../core/workspace';

export interface DependencyInfo {
  name: string;
  range: string;
  section: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
}

export interface ProjectAnalysis {
  ecosystem: string;
  packageManager: string;
  projectName: string | null;
  description: string | null;
  dependencies: DependencyInfo[];
  scripts: Record<string, string>;
  lockfiles: string[];
  lockfileVersion: number | null;
  runtimeDeclarations: { source: string; value: string }[];
  hasBuild: boolean;
  hasTests: boolean;
  testFramework: string | null;
  frameworks: string[];
  languages: { extension: string; files: number }[];
  fileCount: number;
  workflows: string[];
  isMonorepo: boolean;
  /** Ecosystem-specific facts (build backend, edition, ...) shown in the UI and report. */
  details?: Record<string, string>;
  warnings: string[];
}

export interface StepPlan {
  step: StepName;
  /** null when the step does not apply. */
  command: string[] | null;
  skipReason?: SkipReason;
  network: 'none' | 'bridge';
  timeoutMs: number;
}

export interface SandboxHelpers {
  /**
   * Temporarily applies `edits`, regenerates the lockfile in the sandbox without running scripts,
   * and returns the lockfile edit (or null when the project has no lockfile). The workspace is
   * restored before returning.
   */
  regenerateLockfile(edits: FileEdit[]): Promise<FileEdit | null>;
  /** Like 
egenerateLockfile, but returns every regenerated file that changed (e.g. go.mod and go.sum). */
  regenerateFiles(edits: FileEdit[]): Promise<FileEdit[]>;
}

export interface StrategyContext {
  ws: Workspace;
  runtime: RuntimeSelection;
  /** ISO date of the repository's last commit; used for era-matched versions. */
  commitDate: string | null;
  registry: PackageRegistry;
  /** Read-only GitHub lookups for scripts that download upstream files; null when unavailable. */
  upstream?: UpstreamResolver | null;
  sandbox: SandboxHelpers;
  llm: LlmClient | null;
  /** Ecosystem this job is running; strategies and prompts must not cross ecosystems. */
  ecosystem?: { id: string; packageManager: string };
  /** Attempts recorded so far in this job. */
  attempts?: {
    title: string;
    status: string;
    reason?: string;
    fingerprint?: string;
    strategyId?: string;
    /** Tail of the first failing step after a reverted attempt, so a model can see what the change did. */
    detail?: string;
  }[];
  /** Most AI proposals offered for one issue (config LLM_MAX_ATTEMPTS_PER_ISSUE). */
  llmMaxPerIssue?: number;
  current: VerificationResult;
  log: (message: string) => void;
}

export interface FixStrategy {
  id: string;
  handles: IssueKind[];
  /** Lower is tried first. 1 = config only, 2 = runtime pin, 3 = dependency pin/add, 4 = replace dependency, 5 = source edits. */
  invasiveness: number;
  propose(issue: Issue, ctx: StrategyContext): Promise<FixProposal[]>;
}

export interface DiagnoseContext {
  ws: Workspace;
  runtime: RuntimeSelection;
}

export interface EcosystemDetection {
  /** 0..1. 0.9+ means authoritative manifest plus lockfile/tooling evidence. */
  confidence: number;
  evidence: string[];
}

export interface Ecosystem {
  id: string;
  displayName: string;
  /** Language family shown in the UI, e.g. "Python". */
  language: string;
  /** Runtime family this ecosystem executes in. */
  family: RuntimeFamily;
  detect(ws: Workspace): Promise<boolean>;
  /** Confidence-scored detection; null when the ecosystem does not apply. */
  detection(ws: Workspace): Promise<EcosystemDetection | null>;
  /** Extra allow-listed env for sandbox commands (merged over the base env). */
  sandboxEnv(runtime: RuntimeSelection): Record<string, string>;
  /** Whether Node-specific GitHub Actions modernisation applies. */
  supportsCiModernize: boolean;
  /**
   * Last-resort ecosystem: only considered at the repository root or in conventional folders
   * (client, web, ...), and always loses to an ecosystem with a manifest.
   */
  fallback?: boolean;
  /** static when nothing is executed and fixes can only be verified statically. Default 
untime. */
  verification?: 'runtime' | 'static';
  analyze(ws: Workspace): Promise<ProjectAnalysis>;
  selectRuntime(ws: Workspace): Promise<RuntimeSelection>;
  plan(ws: Workspace, runtime: RuntimeSelection, timeouts: Record<StepName, number>): Promise<StepPlan[]>;
  /** Changes when installed dependencies must be reinstalled (manifest, lockfile, config, runtime). */
  installFingerprint(ws: Workspace, runtime: RuntimeSelection): Promise<string>;
  diagnose(result: StepResult, ctx: DiagnoseContext): Promise<Issue[]>;
  /** Issues detectable from files alone that the runtime repair loop should fix. */
  staticIssues(ws: Workspace): Promise<Issue[]>;
  /** Informational findings from logs (e.g. deprecated packages). */
  warningsFromLogs(output: string): string[];
  /** Command (argv) that regenerates the lockfile without running scripts, or null if no lockfile. */
  lockfileRegeneration(
    ws: Workspace,
  ): Promise<{ command: string[]; lockfile: string; extraFiles?: string[] } | null>;
  strategies: FixStrategy[];
}
