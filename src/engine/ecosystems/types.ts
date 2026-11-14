import type { LlmClient, PackageRegistry } from '../core/ports';
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
}

export interface StrategyContext {
  ws: Workspace;
  runtime: RuntimeSelection;
  /** ISO date of the repository's last commit; used for era-matched versions. */
  commitDate: string | null;
  registry: PackageRegistry;
  sandbox: SandboxHelpers;
  llm: LlmClient | null;
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

export interface Ecosystem {
  id: string;
  displayName: string;
  detect(ws: Workspace): Promise<boolean>;
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
  lockfileRegeneration(ws: Workspace): Promise<{ command: string[]; lockfile: string } | null>;
  strategies: FixStrategy[];
}
