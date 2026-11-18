import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoRef } from '@/lib/github';
import { analyzeWorkflow, isValidYaml } from './ci/github-actions';
import { ResurrectionError, toResurrectionError } from './core/errors';
import { createGitPatch } from './core/patch';
import { aggregateHealth, prefixPath } from './core/projects';
import type {
  Clock,
  EventSink,
  LlmClient,
  PackageRegistry,
  PipelineEvent,
  Sandbox,
  UpstreamResolver,
} from './core/ports';
import { systemClock } from './core/ports';
import { healthForStatus, JobStateMachine } from './core/state';
import type {
  AttemptRecord,
  FileEdit,
  FixProposal,
  Health,
  Issue,
  JobStatus,
  RuntimeSelection,
  StageName,
  VerificationResult,
} from './core/types';
import { STEP_NAMES } from './core/types';
import { computeHealth, computeStaticHealth, decideAcceptance, summarizeSteps } from './core/verification';
import { type FileChange, Workspace } from './core/workspace';
import { discoverProjects, ECOSYSTEMS } from './ecosystems';
import { listWorkflows } from './ecosystems/shared';
import type { Ecosystem, FixStrategy, ProjectAnalysis, StrategyContext } from './ecosystems/types';
import { ISSUE_EXPLANATIONS, SUGGESTION_ONLY } from './explanations';
import { llmSourceFix } from './llm/llm-strategy';
import {
  buildReport,
  type ReportProjectInput,
  type ResurrectionReport,
  summarizeVerification,
} from './report';
import { Verifier } from './verifier';

export const CLONE_IMAGE = 'node:22';

export interface PipelineConfig {
  maxAttempts: number;
  jobTimeoutMs: number;
  cloneTimeoutMs: number;
  timeouts: { install: number; build: number; test: number };
  networkForBuild: boolean;
  /** Maximum number of projects verified in one multi-project repository. Defaults to 4. */
  maxProjects?: number;
  /** Most AI proposals offered for one issue. Defaults to 3. */
  llmMaxPerIssue?: number;
}

export interface JobUpdate {
  status?: JobStatus;
  health?: Health;
  heartbeat?: number;
  currentStage?: StageName;
  commitSha?: string;
  commitDate?: Date;
  runtime?: string;
  analysis?: unknown;
  ecosystem?: string;
  packageManager?: string;
  baseline?: unknown;
  final?: unknown;
  report?: ResurrectionReport;
  patch?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobReporter {
  update(fields: JobUpdate): Promise<void>;
  saveAttempt(attempt: AttemptRecord): Promise<void>;
}

export interface PipelineDeps {
  sandbox: Sandbox;
  registry: PackageRegistry;
  /** Per-ecosystem registries (e.g. PyPI, crates.io); falls back to `registry`. */
  registries?: Record<string, PackageRegistry>;
  llm: LlmClient | null;
  /** Optional read-only GitHub lookups used by strategies that repair broken upstream downloads. */
  upstream?: UpstreamResolver | null;
  sink: EventSink;
  reporter: JobReporter;
  clock?: Clock;
  ecosystems?: Ecosystem[];
  isCancelled?: () => Promise<boolean>;
}

export interface PipelineInput {
  jobId: string;
  repo: RepoRef;
  /** Host directory owned by this job. The pipeline creates `repo/` and `cache/` inside it. */
  jobDir: string;
  /** Skip cloning (tests): the repository is already in `<jobDir>/repo`. */
  preCloned?: { commitSha: string; commitDate: string | null };
}

export interface PipelineOutcome {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  health: Health;
  report: ResurrectionReport;
  patch: string;
  attempts: AttemptRecord[];
  workspace: Workspace | null;
}

/** Ecosystem-neutral base env for sandbox commands. Ecosystems add their own via `sandboxEnv`. */
const SANDBOX_ENV: Record<string, string> = { CI: 'true', FORCE_COLOR: '0' };

/** Errors that stop the whole job even when other projects could continue. */
const JOB_FATAL_CODES: ReadonlySet<string> = new Set(['CANCELLED', 'DOCKER_UNAVAILABLE', 'JOB_TIMEOUT']);

/** One project (the root, or a sub-folder) being resurrected inside a job. */
interface ProjectRun {
  /** Folder relative to the repository root; empty for the root project. */
  folder: string;
  ws: Workspace;
  eco: Ecosystem;
  analysis: ProjectAnalysis | null;
  verifier: Verifier | null;
  baseline: VerificationResult | null;
  state: VerificationResult | null;
  final: VerificationResult | null;
  error: ResurrectionError | null;
  notRun?: string;
}

/** Tags log lines from a project's verifier with its folder so the Terminal shows which project ran. */
class ProjectSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly folder: string,
  ) {}
  emit(event: PipelineEvent): void {
    this.inner.emit(
      event.type === 'log' && this.folder
        ? { ...event, message: `[${this.folder}] ${event.message}` }
        : event,
    );
  }
}

/** Stable identity of a proposal's edits, so a re-worded but identical proposal is not tried twice. */
export function editsKey(edits: FileEdit[]): string {
  const h = createHash('sha256');
  for (const e of [...edits].sort((a, b) => a.path.localeCompare(b.path)))
    h.update(`${e.path}\0${e.content === null ? '<delete>' : e.content}\0`);
  return h.digest('hex');
}

function meanScore(values: (number | undefined)[]): number {
  const v = values.filter((x): x is number => typeof x === 'number');
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
}

function sortIssues(issues: Issue[]): Issue[] {
  const stepOrder = (s: Issue['step']) => (s === 'static' ? 0 : STEP_NAMES.indexOf(s));
  const sev = { critical: 0, error: 1, warning: 2, info: 3 } as const;
  return [...issues].sort(
    (a, b) => stepOrder(a.step) - stepOrder(b.step) || sev[a.severity] - sev[b.severity],
  );
}

export class ResurrectionPipeline {
  private readonly clock: Clock;
  private readonly sm = new JobStateMachine('QUEUED');
  private readonly attempts: AttemptRecord[] = [];
  private readonly startedAt: number;
  private heartbeat = 0;
  /** Folder of the project currently being processed ("" for the root project or job-level work). */
  private folder = '';
  /** Outcome detail of reverted attempts by seq, shown to the AI strategy on the next try. */
  private readonly attemptDetail = new Map<number, string>();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly config: PipelineConfig,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.startedAt = this.clock.now();
  }

  // ------------------------------------------------------------------ helpers

  private log(
    message: string,
    level: 'info' | 'warn' | 'error' | 'success' | 'debug' = 'info',
    source = 'engine',
  ) {
    this.deps.sink.emit({
      type: 'log',
      level,
      message: this.folder ? `[${this.folder}] ${message}` : message,
      source,
    });
  }

  private async setStatus(status: JobStatus, message: string, extra: JobUpdate = {}) {
    this.sm.transition(status);
    const health = healthForStatus(status);
    this.deps.sink.emit({ type: 'status', status, health, message });
    await this.deps.reporter.update({ status, health, ...extra });
  }

  private async stage(stage: StageName, message: string) {
    this.deps.sink.emit({ type: 'stage', stage, message });
    await this.deps.reporter.update({ currentStage: stage });
  }

  private async beat(value: number, message: string) {
    this.heartbeat = value;
    this.deps.sink.emit({ type: 'heartbeat', value, message });
    await this.deps.reporter.update({ heartbeat: value });
  }

  private async checkCancelled() {
    if (this.deps.isCancelled && (await this.deps.isCancelled())) {
      throw new ResurrectionError('CANCELLED', 'The resurrection was cancelled.');
    }
  }

  private timeLeft(): number {
    return this.config.jobTimeoutMs - (this.clock.now() - this.startedAt);
  }

  private async recordAttempt(a: Omit<AttemptRecord, 'seq'>): Promise<AttemptRecord> {
    const attempt: AttemptRecord = {
      ...a,
      seq: this.attempts.length + 1,
      ...(this.folder ? { project: this.folder, files: a.files.map((f) => prefixPath(this.folder, f)) } : {}),
    };
    this.attempts.push(attempt);
    await this.deps.reporter.saveAttempt(attempt);
    this.deps.sink.emit({ type: 'attempt', attempt, message: `${attempt.status}: ${attempt.title}` });
    return attempt;
  }

  // ------------------------------------------------------------------ stages

  private async clone(input: PipelineInput, repoDir: string): Promise<{ sha: string; date: string | null }> {
    if (input.preCloned) return { sha: input.preCloned.commitSha, date: input.preCloned.commitDate };
    await this.deps.sandbox.ensureImage(CLONE_IMAGE, (l) => this.log(l, 'debug', 'docker'));
    const script =
      'git -c init.defaultBranch=main clone --depth 1 --single-branch --no-tags --quiet -- "$1" . ' +
      '&& git -c safe.directory="*" log -1 --format=%H%n%cI';
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.log(`$ git clone --depth 1 ${input.repo.url}`, 'info', 'clone');
      const res = await this.deps.sandbox.run(
        {
          image: CLONE_IMAGE,
          command: ['sh', '-c', script, 'clone', input.repo.url],
          workdir: repoDir,
          network: 'bridge',
          timeoutMs: this.config.cloneTimeoutMs,
          env: { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
          label: 'clone',
        },
        (l) => this.log(l, 'debug', 'clone'),
      );
      if (res.exitCode === 0 && !res.timedOut) {
        const lines = res.output.trim().split(/\r?\n/);
        const date = lines.pop()?.trim() ?? '';
        const sha = lines.pop()?.trim() ?? '';
        if (/^[0-9a-f]{40}$/.test(sha)) return { sha, date: Number.isNaN(Date.parse(date)) ? null : date };
        throw new ResurrectionError('CLONE_FAILED', 'Cloned the repository but could not read the commit.');
      }
      if (
        /Repository not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(
          res.output,
        )
      ) {
        throw new ResurrectionError(
          'REPO_NOT_FOUND_OR_PRIVATE',
          'Repository not found or private. Private repositories are not supported yet.',
        );
      }
      const network =
        res.timedOut ||
        /Could not resolve host|Connection (?:timed out|reset|refused)|early EOF|RPC failed/i.test(
          res.output,
        );
      if (!network)
        throw new ResurrectionError(
          'CLONE_FAILED',
          `git clone failed: ${res.output.split(/\r?\n/).slice(-3).join(' ')}`,
        );
      if (attempt === 2)
        throw new ResurrectionError('NETWORK_ERROR', 'Network error while cloning the repository.');
      this.log('Network error while cloning; retrying once.', 'warn', 'clone');
      await this.deps.sandbox.run({
        image: CLONE_IMAGE,
        command: ['sh', '-c', 'rm -rf ./* ./.[!.]* 2>/dev/null; true'],
        workdir: repoDir,
        network: 'none',
        timeoutMs: 60_000,
        label: 'clean',
      });
    }
    throw new ResurrectionError('CLONE_FAILED', 'git clone failed.');
  }

  private strategiesFor(eco: Ecosystem): FixStrategy[] {
    const all = [...eco.strategies];
    if (this.deps.llm) all.push(llmSourceFix);
    return all.sort((a, b) => a.invasiveness - b.invasiveness);
  }

  private async repairLoop(
    ws: Workspace,
    eco: Ecosystem,
    verifier: Verifier,
    baseline: VerificationResult,
    commitDate: string | null,
    cacheDir: string,
    pm: string,
  ): Promise<VerificationResult> {
    let state = baseline;
    const tried = new Set<string>();
    const strategies = this.strategiesFor(eco);
    const suggested = new Set<string>();
    const explained = new Set<string>();
    let runtimeAttempts = 0;

    while (runtimeAttempts < this.config.maxAttempts) {
      await this.checkCancelled();
      if (this.timeLeft() < this.config.timeouts.install) {
        this.log('Time budget nearly exhausted; stopping repairs.', 'warn');
        break;
      }
      const runtime = await verifier.runtime();
      const ctx: StrategyContext = {
        ws,
        runtime,
        commitDate,
        registry: this.deps.registries?.[eco.id] ?? this.deps.registry,
        upstream: this.deps.upstream ?? null,
        llm: this.deps.llm,
        ecosystem: { id: eco.id, packageManager: pm },
        attempts: this.attempts
          .filter((a) => (a.project ?? '') === this.folder)
          .map((a) => ({
            title: a.title,
            status: a.status,
            reason: a.reason,
            fingerprint: a.fingerprint,
            strategyId: a.strategyId,
            detail: this.attemptDetail.get(a.seq),
          })),
        llmMaxPerIssue: this.config.llmMaxPerIssue,
        current: state,
        log: (m) => this.log(m, 'info', 'repair'),
        sandbox: {
          regenerateFiles: (edits) => this.regenerateFiles(ws, eco, edits, runtime, cacheDir),
          regenerateLockfile: async (edits) => {
            const files = await this.regenerateFiles(ws, eco, edits, runtime, cacheDir);
            const lock = (await eco.lockfileRegeneration(ws))?.lockfile;
            return files.find((f) => f.path === lock) ?? null;
          },
        },
      };

      let pick: { issue: Issue; proposal: FixProposal } | null = null;
      outer: for (const issue of sortIssues(state.issues)) {
        if (SUGGESTION_ONLY.has(issue.kind)) {
          if (!suggested.has(issue.fingerprint)) {
            suggested.add(issue.fingerprint);
            await this.suggest(issue);
          }
          continue;
        }
        const handlers = strategies.filter((s) => s.handles.includes(issue.kind));
        const considered: string[] = [];
        if (handlers.length === 0 && !explained.has(issue.fingerprint)) {
          explained.add(issue.fingerprint);
          this.log(`No automatic strategy handles "${issue.kind}" (${issue.title}).`, 'warn', 'repair');
        }
        for (const strategy of handlers) {
          let proposals: FixProposal[] = [];
          try {
            proposals = await strategy.propose(issue, ctx);
          } catch (err) {
            this.log(
              `Strategy ${strategy.id} failed: ${err instanceof Error ? err.message : String(err)}`,
              'warn',
              'repair',
            );
            const key = `${issue.fingerprint}::${strategy.id}::error`;
            considered.push(`${strategy.id}: error`);
            if (!tried.has(key)) {
              tried.add(key);
              await this.recordAttempt({
                issueKind: issue.kind,
                fingerprint: issue.fingerprint,
                strategyId: strategy.id,
                title: `${strategy.id} could not produce a fix`,
                rationale: ISSUE_EXPLANATIONS[issue.kind].cause,
                status: 'ERROR',
                reason: err instanceof Error ? err.message : String(err),
                files: [],
                durationMs: 0,
              });
            }
            continue;
          }
          const fresh = proposals.filter(
            (p) =>
              p.edits.length > 0 &&
              !tried.has(`${issue.fingerprint}::${strategy.id}::${p.title}`) &&
              !tried.has(`${issue.fingerprint}::edits::${editsKey(p.edits)}`),
          );
          considered.push(
            `${strategy.id}: ${fresh.length ? `${fresh.length} candidate(s)` : 'nothing to try'}`,
          );
          const proposal = fresh[0];
          if (proposal) {
            tried.add(`${issue.fingerprint}::${strategy.id}::${proposal.title}`);
            tried.add(`${issue.fingerprint}::edits::${editsKey(proposal.edits)}`);
            this.log(`Investigating: ${issue.title}. Consulted ${considered.join('; ')}.`, 'info', 'repair');
            pick = { issue, proposal };
            break outer;
          }
        }
        if (handlers.length > 0 && !explained.has(issue.fingerprint)) {
          explained.add(issue.fingerprint);
          this.log(
            `No safe fix found for "${issue.title}". Consulted ${considered.join('; ')}.`,
            'warn',
            'repair',
          );
        }
      }
      if (!pick) break;

      runtimeAttempts++;
      state = await this.tryFix(ws, verifier, state, pick.issue, pick.proposal);
      await this.beat(state.score, `Heartbeat ${state.score}`);
    }

    // Anything left with no automatic fix becomes a suggestion so the user knows what to do next.
    for (const issue of state.issues) {
      if (
        !suggested.has(issue.fingerprint) &&
        !this.attempts.some(
          (a) =>
            a.fingerprint === issue.fingerprint &&
            (a.project ?? '') === this.folder &&
            (a.status === 'VERIFIED' || a.status === 'VERIFIED_STATIC'),
        )
      ) {
        suggested.add(issue.fingerprint);
        await this.suggest(issue);
      }
    }
    return state;
  }

  private async suggest(issue: Issue) {
    await this.recordAttempt({
      issueKind: issue.kind,
      fingerprint: issue.fingerprint,
      strategyId: 'manual',
      title: `Manual follow-up: ${issue.title}`,
      rationale: `${ISSUE_EXPLANATIONS[issue.kind].cause} ${ISSUE_EXPLANATIONS[issue.kind].advice}`,
      status: 'SUGGESTED',
      reason: 'Not applied: no automatic fix could be verified for this issue.',
      files: [],
      durationMs: 0,
    });
  }

  private async tryFix(
    ws: Workspace,
    verifier: Verifier,
    prev: VerificationResult,
    issue: Issue,
    proposal: FixProposal,
  ): Promise<VerificationResult> {
    const started = this.clock.now();
    if (this.sm.status === 'VERIFYING') await this.setStatus('REPAIRING', 'Applying the next fix');
    this.log(`Trying fix: ${proposal.title}`, 'info', 'repair');
    const beforeContents = await Promise.all(
      proposal.edits.map(async (e) => ({ path: e.path, before: await ws.current(e.path) })),
    );
    const snapshot = await ws.applyEdits(proposal.edits);
    const diff = createGitPatch(
      beforeContents.map((b, i) => ({
        path: prefixPath(this.folder, b.path),
        before: b.before,
        after: proposal.edits[i]!.content,
      })),
    );
    this.log(
      `Candidate patch applied in the sandbox workspace: ${proposal.edits.map((e) => e.path).join(', ')}`,
      'info',
      'patch',
    );
    await this.setStatus('VERIFYING', `Verifying: ${proposal.title}`);
    this.log('Re-running install, build, and test with the candidate applied.', 'info', 'verify');

    let next: Awaited<ReturnType<Verifier['verify']>>;
    try {
      next = await verifier.verify();
    } catch (err) {
      // Never leave an unverified candidate in the workspace (and therefore in the patch).
      await ws.rollback(snapshot);
      this.log(`Verification aborted; candidate rolled back: ${proposal.title}`, 'warn', 'verify');
      throw err;
    }
    const decision = decideAcceptance(prev, next, issue.fingerprint);
    const base = {
      issueKind: issue.kind,
      fingerprint: issue.fingerprint,
      strategyId: proposal.strategyId,
      title: proposal.title,
      rationale: proposal.rationale,
      files: proposal.edits.map((e) => e.path),
      diff,
      verification: { runtime: next.runtime, score: next.score, steps: summarizeSteps(next.steps) },
      durationMs: this.clock.now() - started,
      reason: decision.reason,
    };
    if (decision.accept) {
      // A fix that was only checked statically (nothing was executed) must never read as runtime-verified.
      const staticOnly = proposal.kind === 'static';
      const reason = staticOnly
        ? `Statically verified: the targeted issue is gone and nothing that passed before regressed. The project was not executed. ${decision.reason}`
        : decision.reason;
      this.log(`Fix verified and kept: ${proposal.title}. ${reason}`, 'success', 'repair');
      await this.recordAttempt({ ...base, reason, status: staticOnly ? 'VERIFIED_STATIC' : 'VERIFIED' });
      return next;
    }
    await ws.rollback(snapshot);
    this.log(`Fix reverted: ${proposal.title}. ${decision.reason}`, 'warn', 'repair');
    const failing = STEP_NAMES.find(
      (s) => next.steps[s].status === 'failed' || next.steps[s].status === 'timeout',
    );
    const reverted = await this.recordAttempt({ ...base, status: 'REVERTED' });
    this.attemptDetail.set(
      reverted.seq,
      failing
        ? `After this change ${failing} ${next.steps[failing].status}:\n${next.steps[failing].logTail.slice(-1500)}`
        : decision.reason,
    );
    return prev;
  }

  /**
   * Run the ecosystem's lockfile command with `edits` applied, return every regenerated file that changed
   * (the lockfile and any `extraFiles`), then restore the workspace. The caller decides what to keep.
   */
  private async regenerateFiles(
    ws: Workspace,
    eco: Ecosystem,
    edits: FileEdit[],
    runtimeSel: RuntimeSelection,
    cacheDir: string,
  ): Promise<FileEdit[]> {
    const regen = await eco.lockfileRegeneration(ws);
    if (!regen) return [];
    const paths = [regen.lockfile, ...(regen.extraFiles ?? [])];
    const before = new Map<string, string | null>();
    for (const p of paths) before.set(p, await ws.current(p));
    // Track the files in the snapshot so rollback restores them even if they were untouched so far.
    const snapshot = await ws.applyEdits([
      ...edits,
      ...paths.map((p) => ({ path: p, content: before.get(p) ?? null })),
    ]);
    try {
      this.log(`$ ${regen.command.join(' ')}`, 'info', 'lockfile');
      const res = await this.deps.sandbox.run(
        {
          image: runtimeSel.image,
          command: regen.command,
          workdir: ws.root,
          cacheDir,
          network: 'bridge',
          timeoutMs: this.config.timeouts.install,
          env: { ...SANDBOX_ENV, ...eco.sandboxEnv(runtimeSel) },
          label: 'lockfile',
        },
        (l) => this.log(l, 'debug', 'lockfile'),
      );
      if (res.exitCode !== 0 || res.timedOut) {
        this.log('Lockfile regeneration failed; skipping this proposal.', 'warn', 'lockfile');
        return [];
      }
      const out: FileEdit[] = [];
      for (const p of paths) {
        const content = await ws.read(p);
        if (content !== null && content !== before.get(p)) out.push({ path: p, content });
      }
      return out;
    } finally {
      await ws.rollback(snapshot);
    }
  }
  private async staticCiFixes(ws: Workspace, workflows: string[], targetMajor: number): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const wf of workflows) {
      const text = await ws.current(wf).catch(() => null);
      if (text === null) continue;
      const res = analyzeWorkflow(text, targetMajor);
      if (!res.findings.length) continue;
      const issue: Issue = {
        kind: 'outdated-ci',
        fingerprint: `outdated-ci:${wf}`,
        step: 'static',
        severity: 'warning',
        title: `Outdated GitHub Actions configuration in ${wf}`,
        evidence: res.findings.map((f) => `line ${f.line}: ${f.message}`).join('\n'),
        data: { path: wf },
      };
      issues.push(issue);
      this.deps.sink.emit({ type: 'issue', issue, message: issue.title });

      const started = this.clock.now();
      const diff = createGitPatch([{ path: wf, before: text, after: res.text }]);
      const snapshot = await ws.applyEdits([{ path: wf, content: res.text }]);
      const ok = isValidYaml(res.text) && analyzeWorkflow(res.text, targetMajor).findings.length === 0;
      if (!ok) await ws.rollback(snapshot);
      await this.recordAttempt({
        issueKind: 'outdated-ci',
        fingerprint: issue.fingerprint,
        strategyId: 'ci-modernize',
        title: `Modernize ${wf}`,
        rationale: `${ISSUE_EXPLANATIONS['outdated-ci'].cause} Changes: ${[...new Set(res.findings.map((f) => f.message))].join(' ')}`,
        status: ok ? 'VERIFIED_STATIC' : 'REVERTED',
        reason: ok
          ? 'Statically verified: the workflow is valid YAML and no outdated rules remain. GitHub Actions itself was not run.'
          : 'The rewritten workflow did not validate, so it was reverted.',
        files: [wf],
        diff,
        durationMs: this.clock.now() - started,
      });
    }
    return issues;
  }

  // ------------------------------------------------------------------ main

  async run(input: PipelineInput): Promise<PipelineOutcome> {
    const repoDir = path.join(input.jobDir, 'repo');
    const cacheDir = path.join(input.jobDir, 'cache');
    let ws: Workspace | null = null;
    let runs: ProjectRun[] = [];
    let notRunProjects: { folder: string; ecosystem: string; reason: string }[] = [];
    let staticIssues: Issue[] = [];
    let commit: { sha: string; date: string | null } | null = null;
    let warnings: string[] = [];
    let error: ResurrectionError | null = null;

    /**
     * Run `fn` for every project that is still active. With several projects an error ends only that
     * project (the others continue); job-fatal errors and single-project jobs rethrow as before.
     */
    const phase = async (fn: (run: ProjectRun) => Promise<void>): Promise<void> => {
      const isolate = runs.length > 1;
      for (const run of runs) {
        if (run.notRun || run.error) continue;
        this.folder = run.folder;
        try {
          await this.checkCancelled();
          await fn(run);
        } catch (err) {
          const e = toResurrectionError(err);
          if (!isolate || JOB_FATAL_CODES.has(e.code)) throw err;
          run.error = e;
          this.log(`${e.code}: ${e.message}. Continuing with the other projects.`, 'error', 'engine');
        } finally {
          this.folder = '';
        }
      }
    };

    try {
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(cacheDir, { recursive: true });

      await this.setStatus('CLONING', `Exhuming ${input.repo.owner}/${input.repo.name}`);
      await this.stage('clone', 'Cloning repository into an isolated sandbox');
      commit = await this.clone(input, repoDir);
      this.log(
        `Cloned commit ${commit.sha.slice(0, 12)}${commit.date ? ` from ${commit.date.slice(0, 10)}` : ''}`,
        'success',
        'clone',
      );
      await this.deps.reporter.update({
        commitSha: commit.sha,
        commitDate: commit.date ? new Date(commit.date) : undefined,
      });
      const commitDate = commit.date;

      await this.checkCancelled();
      await this.setStatus('ANALYZING', 'Examining the remains');
      await this.stage('analyze', 'Inspecting manifest, lockfiles, scripts, and workflows');
      ws = await Workspace.open(repoDir);
      const registered = this.deps.ecosystems ?? ECOSYSTEMS;
      const discovery = await discoverProjects(ws, registered, { maxProjects: this.config.maxProjects });
      if (discovery.projects.length === 0)
        throw new ResurrectionError(
          'NO_SUPPORTED_PROJECT',
          `No supported project found at the repository root or in its sub-folders. Supported: ${registered.map((e) => e.displayName).join(', ')}.`,
        );
      notRunProjects = discovery.notRun;
      runs = discovery.projects.map((p) => ({
        folder: p.folder,
        ws: p.ws,
        eco: p.ecosystem,
        analysis: null,
        verifier: null,
        baseline: null,
        state: null,
        final: null,
        error: null,
      }));
      for (const w of discovery.warnings) {
        warnings.push(w);
        this.log(w, 'warn', 'analyze');
      }
      for (const n of notRunProjects) {
        const msg = `${n.folder || '(root)'}: ${n.reason}`;
        warnings.push(msg);
        this.log(msg, 'warn', 'analyze');
      }
      for (const p of discovery.projects) {
        if (!p.detection.ambiguous) continue;
        const names = p.detection.candidates
          .map(
            (c) =>
              `${c.ecosystem.displayName} (${c.detection.confidence.toFixed(2)}: ${c.detection.evidence.join(', ')})`,
          )
          .join('; ');
        const msg = `${p.folder ? `[${p.folder}] ` : ''}Ambiguous ecosystem detection; using ${p.ecosystem.displayName}. Candidates: ${names}.`;
        warnings.push(msg);
        this.log(msg, 'warn', 'analyze');
      }

      await phase(async (run) => {
        const analysis = await run.eco.analyze(run.ws);
        run.analysis = analysis;
        warnings.push(...analysis.warnings.map((w) => (run.folder ? `[${run.folder}] ${w}` : w)));
        if (run === runs[0]) {
          await this.deps.reporter.update({
            analysis,
            ecosystem: run.eco.id,
            packageManager: analysis.packageManager,
          });
        }
        this.log(
          `${run.eco.displayName} project${analysis.projectName ? ` "${analysis.projectName}"` : ''}: ${analysis.dependencies.length} dependencies, ` +
            `lockfile: ${analysis.lockfiles.join(', ') || 'none'}, build: ${analysis.hasBuild ? 'yes' : 'no'}, tests: ${analysis.hasTests ? (analysis.testFramework ?? 'yes') : 'none'}`,
          'info',
          'analyze',
        );
        for (const w of analysis.warnings) this.log(w, 'warn', 'analyze');
        run.verifier = new Verifier(
          run.ws,
          run.eco,
          this.deps.sandbox,
          new ProjectSink(this.deps.sink, run.folder),
          {
            timeouts: this.config.timeouts,
            networkForBuild: this.config.networkForBuild,
            cacheDir,
            env: SANDBOX_ENV,
          },
        );
      });

      await this.checkCancelled();
      await this.setStatus('BASELINE', 'Recording baseline failures');
      await this.stage('baseline', 'Running install, build, and test on the untouched code');
      await phase(async (run) => {
        if (run !== runs[0] && this.timeLeft() < this.config.timeouts.install) {
          run.notRun = 'Not run: the job time budget was exhausted.';
          this.log(run.notRun, 'warn', 'baseline');
          return;
        }
        const verifier = run.verifier!;
        const runtime = await verifier.runtime();
        this.log(`Selected ${runtime.label} (from ${runtime.source})`, 'info', 'baseline');
        run.baseline = await verifier.verify({ clean: true });
        run.state = run.baseline;
        if (run === runs[0]) {
          await this.deps.reporter.update({
            baseline: summarizeVerification(run.baseline),
            runtime: run.baseline.runtime,
          });
        }
      });
      const baselineScore = meanScore(runs.map((r) => r.baseline?.score));
      await this.beat(baselineScore, `Baseline heartbeat ${baselineScore}`);

      await this.setStatus('DIAGNOSING', 'Diagnosing cause of death');
      await this.stage('diagnose', 'Classifying failures');
      await phase(async (run) => {
        const baseline = run.baseline;
        if (!baseline) return;
        for (const issue of baseline.issues) {
          this.deps.sink.emit({
            type: 'issue',
            issue: run.folder ? { ...issue, title: `[${run.folder}] ${issue.title}` } : issue,
            message: run.folder ? `[${run.folder}] ${issue.title}` : issue.title,
          });
          this.log(`Found: ${issue.title}`, issue.severity === 'warning' ? 'warn' : 'error', 'diagnose');
          const d = issue.diagnostic;
          if (d) {
            const parts = [
              `category=${d.category}`,
              d.file && `file=${d.file}`,
              d.lifecycle && `lifecycle=${d.lifecycle}`,
              d.command && `command=${d.command}`,
              d.httpStatus && `http=${d.httpStatus}`,
              d.resources?.length && `resources=${d.resources.join(',')}`,
            ].filter(Boolean);
            this.log(`  ${parts.join(' ')}`, 'info', 'diagnose');
          }
        }
        if (baseline.issues.length === 0) this.log('No runtime failures found.', 'success', 'diagnose');
      });

      if (runs.some((r) => !r.notRun && !r.error && (r.baseline?.issues.length ?? 0) > 0)) {
        await this.setStatus('REPAIRING', 'Attempting resurrection');
        await this.stage('repair', 'Applying fixes one at a time, verifying each');
        await phase(async (run) => {
          if (!run.baseline || run.baseline.issues.length === 0) return;
          if (this.sm.status !== 'REPAIRING') await this.setStatus('REPAIRING', 'Attempting resurrection');
          run.state = await this.repairLoop(
            run.ws,
            run.eco,
            run.verifier!,
            run.baseline,
            commitDate,
            cacheDir,
            run.analysis!.packageManager,
          );
          const mine = this.attempts.filter((a) => (a.project ?? '') === run.folder);
          const count = (s: string) => mine.filter((a) => a.status === s).length;
          this.log(
            `Repair stage finished: ${count('VERIFIED')} verified, ${count('REVERTED')} reverted, ${count('ERROR')} errored, ${count('SUGGESTED')} suggested (unverified).`,
            'info',
            'repair',
          );
        });
      }

      await this.checkCancelled();
      // GitHub Actions workflows live at the repository root and are fixed once, after the projects.
      const ciRun = runs.find((r) => r.eco.supportsCiModernize && r.verifier && !r.error && !r.notRun);
      if (ciRun) {
        const finalRuntime = await ciRun.verifier!.runtime();
        const rootRun = runs.find((r) => r.folder === '');
        const workflows = rootRun?.analysis?.workflows ?? (await listWorkflows(ws));
        staticIssues = await this.staticCiFixes(ws, workflows, finalRuntime.major);
      }

      if (this.sm.status !== 'VERIFYING') await this.setStatus('VERIFYING', 'Final verification');
      await this.stage('finalize', 'Clean reinstall and final verification');
      await phase(async (run) => {
        const anyChange = run.ws.changes().some((c) => !c.path.startsWith('.github/'));
        run.final =
          anyChange || run.state !== run.baseline
            ? await run.verifier!.verify({ clean: true })
            : run.baseline;
        if (run === runs[0] && run.final) {
          await this.deps.reporter.update({
            final: summarizeVerification(run.final),
            runtime: run.final.runtime,
          });
        }
      });
      const finalScore = meanScore(runs.map((r) => r.final?.score));
      await this.beat(finalScore, `Final heartbeat ${finalScore}`);
      for (const run of runs) {
        for (const w of run.verifier?.warnings ?? []) warnings.push(run.folder ? `[${run.folder}] ${w}` : w);
      }
      warnings = [...new Set(warnings)];
    } catch (err) {
      error = toResurrectionError(err);
      this.log(`${error.code}: ${error.message}`, 'error', 'engine');
    }
    this.folder = '';

    // ------------------------------------------------------------ report (always)
    const cancelled = error?.code === 'CANCELLED';
    const noSupportedProject = error?.code === 'NO_SUPPORTED_PROJECT';

    // One patch for the whole repository: project paths are re-based onto the repository root.
    const changes: FileChange[] = [];
    if (ws) {
      const sources: { folder: string; ws: Workspace }[] = [{ folder: '', ws }];
      for (const run of runs) if (run.folder !== '') sources.push({ folder: run.folder, ws: run.ws });
      for (const s of sources)
        for (const c of s.ws.changes()) changes.push({ ...c, path: prefixPath(s.folder, c.path) });
      changes.sort((a, b) => a.path.localeCompare(b.path));
    }
    const patch = createGitPatch(changes);

    const projectResults = runs.map((r) => {
      const ran = !r.notRun && r.baseline !== null;
      const health =
        r.eco.verification === 'static'
          ? computeStaticHealth(r.baseline, r.final)
          : computeHealth(r.baseline, r.final);
      return { run: r, ran, health };
    });
    const health: Health =
      error && !noSupportedProject
        ? 'UNRECOVERABLE'
        : aggregateHealth([
            ...projectResults.map((p) => ({ health: p.health, ran: p.ran })),
            ...notRunProjects.map(() => ({ health: 'UNRECOVERABLE' as Health, ran: false })),
          ]);

    const primary = runs.find((r) => r.baseline) ?? runs[0] ?? null;
    const reportProjects: ReportProjectInput[] | undefined =
      runs.length > 1 || notRunProjects.length > 0
        ? [
            ...projectResults.map(({ run, ran, health: h }) => ({
              folder: run.folder,
              ecosystem: run.eco.id,
              packageManager: run.analysis?.packageManager ?? null,
              analysis: run.analysis,
              baseline: run.baseline,
              final: run.final,
              health: h,
              notRun: run.notRun ?? (ran ? undefined : 'Not run.'),
              error: run.error ? { code: run.error.code, message: run.error.message } : undefined,
            })),
            ...notRunProjects.map((n) => ({
              folder: n.folder,
              ecosystem: n.ecosystem,
              packageManager: null,
              analysis: null,
              baseline: null,
              final: null,
              health: 'UNRECOVERABLE' as Health,
              notRun: n.reason,
            })),
          ]
        : undefined;

    const report = buildReport({
      repo: {
        owner: input.repo.owner,
        name: input.repo.name,
        url: input.repo.url,
        commitSha: commit?.sha ?? null,
        commitDate: commit?.date ?? null,
      },
      health,
      ecosystem: primary?.eco.id ?? null,
      analysis: primary?.analysis ?? null,
      baseline: primary?.baseline ?? null,
      final: primary?.final ?? null,
      projects: reportProjects,
      staticOnly: runs.length > 0 && runs.every((r) => r.eco.verification === 'static'),
      staticIssues,
      attempts: this.attempts,
      changes,
      patch,
      warnings,
      durationMs: this.clock.now() - this.startedAt,
      now: new Date(this.clock.now()),
      error: error ? { code: error.code, message: error.message } : undefined,
    });

    this.log(
      `Resurrection report generated: health ${health}, ${changes.length} file(s) in the verified patch.`,
      health === 'REVIVED' ? 'success' : 'info',
      'report',
    );

    let status: PipelineOutcome['status'];
    if (cancelled) {
      status = 'CANCELLED';
      await this.setStatus('CANCELLED', 'Cancelled', {
        report,
        patch,
        errorCode: error!.code,
        errorMessage: error!.message,
      });
    } else if (error && !noSupportedProject) {
      status = 'FAILED';
      await this.setStatus('FAILED', error.message, {
        report,
        patch,
        errorCode: error.code,
        errorMessage: error.message,
      });
    } else {
      status = 'COMPLETED';
      await this.stage('report', 'Writing the resurrection report');
      await this.setStatus('REPORTING', 'Writing the resurrection report');
      this.sm.transition('COMPLETED');
      this.deps.sink.emit({ type: 'status', status: 'COMPLETED', health, message: report.headline });
      await this.deps.reporter.update({
        status: 'COMPLETED',
        health,
        report,
        patch,
        heartbeat: primary?.final ? meanScore(runs.map((r) => r.final?.score)) : this.heartbeat,
        ...(noSupportedProject ? { errorCode: error!.code, errorMessage: error!.message } : {}),
      });
    }
    this.deps.sink.emit({ type: 'done', health, message: report.headline });
    await this.deps.sink.flush?.();
    return { status, health, report, patch, attempts: this.attempts, workspace: ws };
  }
}
