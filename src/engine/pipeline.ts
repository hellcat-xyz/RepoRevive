import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoRef } from '@/lib/github';
import { analyzeWorkflow, isValidYaml } from './ci/github-actions';
import { ResurrectionError, toResurrectionError } from './core/errors';
import { createGitPatch } from './core/patch';
import type { Clock, EventSink, LlmClient, PackageRegistry, Sandbox, UpstreamResolver } from './core/ports';
import { systemClock } from './core/ports';
import { healthForStatus, JobStateMachine } from './core/state';
import type {
  AttemptRecord,
  FileEdit,
  FixProposal,
  Health,
  Issue,
  JobStatus,
  StageName,
  VerificationResult,
} from './core/types';
import { STEP_NAMES } from './core/types';
import { computeHealth, decideAcceptance, summarizeSteps } from './core/verification';
import { Workspace } from './core/workspace';
import { detectEcosystem, ECOSYSTEMS } from './ecosystems';
import type { Ecosystem, FixStrategy, ProjectAnalysis, StrategyContext } from './ecosystems/types';
import { ISSUE_EXPLANATIONS, SUGGESTION_ONLY } from './explanations';
import { llmSourceFix } from './llm/llm-strategy';
import { buildReport, type ResurrectionReport, summarizeVerification } from './report';
import { Verifier } from './verifier';

export const CLONE_IMAGE = 'node:22';

export interface PipelineConfig {
  maxAttempts: number;
  jobTimeoutMs: number;
  cloneTimeoutMs: number;
  timeouts: { install: number; build: number; test: number };
  networkForBuild: boolean;
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

const SANDBOX_ENV = {
  CI: 'true',
  NODE_ENV: 'development',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_loglevel: 'warn',
  ADBLOCK: '1',
  DISABLE_OPENCOLLECTIVE: '1',
  HUSKY: '0',
  PUPPETEER_SKIP_DOWNLOAD: '1',
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
  CYPRESS_INSTALL_BINARY: '0',
  BROWSERSLIST_IGNORE_OLD_DATA: '1',
  FORCE_COLOR: '0',
};

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
    this.deps.sink.emit({ type: 'log', level, message, source });
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
    const attempt: AttemptRecord = { ...a, seq: this.attempts.length + 1 };
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
        registry: this.deps.registry,
        upstream: this.deps.upstream ?? null,
        llm: this.deps.llm,
        current: state,
        log: (m) => this.log(m, 'info', 'repair'),
        sandbox: {
          regenerateLockfile: (edits) => this.regenerateLockfile(ws, eco, edits, runtime.image, cacheDir),
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
            (p) => p.edits.length > 0 && !tried.has(`${issue.fingerprint}::${strategy.id}::${p.title}`),
          );
          considered.push(
            `${strategy.id}: ${fresh.length ? `${fresh.length} candidate(s)` : 'nothing to try'}`,
          );
          const proposal = fresh[0];
          if (proposal) {
            tried.add(`${issue.fingerprint}::${strategy.id}::${proposal.title}`);
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
        !this.attempts.some((a) => a.fingerprint === issue.fingerprint && a.status === 'VERIFIED')
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
      beforeContents.map((b, i) => ({ path: b.path, before: b.before, after: proposal.edits[i]!.content })),
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
      this.log(`Fix verified and kept: ${proposal.title}. ${decision.reason}`, 'success', 'repair');
      await this.recordAttempt({ ...base, status: 'VERIFIED' });
      return next;
    }
    await ws.rollback(snapshot);
    this.log(`Fix reverted: ${proposal.title}. ${decision.reason}`, 'warn', 'repair');
    await this.recordAttempt({ ...base, status: 'REVERTED' });
    return prev;
  }

  private async regenerateLockfile(
    ws: Workspace,
    eco: Ecosystem,
    edits: FileEdit[],
    image: string,
    cacheDir: string,
  ): Promise<FileEdit | null> {
    const regen = await eco.lockfileRegeneration(ws);
    if (!regen) return null;
    const currentLock = await ws.current(regen.lockfile);
    // Track the lockfile in the snapshot so rollback restores it even if it was untouched so far.
    const snapshot = await ws.applyEdits([...edits, { path: regen.lockfile, content: currentLock }]);
    try {
      this.log(`$ ${regen.command.join(' ')}`, 'info', 'lockfile');
      const res = await this.deps.sandbox.run(
        {
          image,
          command: regen.command,
          workdir: ws.root,
          cacheDir,
          network: 'bridge',
          timeoutMs: this.config.timeouts.install,
          env: SANDBOX_ENV,
          label: 'lockfile',
        },
        (l) => this.log(l, 'debug', 'lockfile'),
      );
      if (res.exitCode !== 0 || res.timedOut) {
        this.log('Lockfile regeneration failed; skipping this proposal.', 'warn', 'lockfile');
        return null;
      }
      const content = await ws.read(regen.lockfile);
      return content !== null && content !== currentLock ? { path: regen.lockfile, content } : null;
    } finally {
      await ws.rollback(snapshot);
    }
  }

  private async staticCiFixes(
    ws: Workspace,
    analysis: ProjectAnalysis,
    targetMajor: number,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const wf of analysis.workflows) {
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
    let eco: Ecosystem | null = null;
    let analysis: ProjectAnalysis | null = null;
    let baseline: VerificationResult | null = null;
    let final: VerificationResult | null = null;
    let staticIssues: Issue[] = [];
    let commit: { sha: string; date: string | null } | null = null;
    let warnings: string[] = [];
    let error: ResurrectionError | null = null;

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

      await this.checkCancelled();
      await this.setStatus('ANALYZING', 'Examining the remains');
      await this.stage('analyze', 'Inspecting manifest, lockfiles, scripts, and workflows');
      ws = await Workspace.open(repoDir);
      eco = await detectEcosystem(ws, this.deps.ecosystems ?? ECOSYSTEMS);
      if (!eco)
        throw new ResurrectionError(
          'NOT_A_NODE_PROJECT',
          'No package.json at the repository root. Only Node.js/npm projects are supported.',
        );
      analysis = await eco.analyze(ws);
      warnings.push(...analysis.warnings);
      await this.deps.reporter.update({ analysis });
      this.log(
        `${eco.displayName} project${analysis.projectName ? ` "${analysis.projectName}"` : ''}: ${analysis.dependencies.length} dependencies, ` +
          `lockfile: ${analysis.lockfiles.join(', ') || 'none'}, build: ${analysis.hasBuild ? 'yes' : 'no'}, tests: ${analysis.hasTests ? (analysis.testFramework ?? 'yes') : 'none'}`,
        'info',
        'analyze',
      );
      for (const w of analysis.warnings) this.log(w, 'warn', 'analyze');

      const verifier = new Verifier(ws, eco, this.deps.sandbox, this.deps.sink, {
        timeouts: this.config.timeouts,
        networkForBuild: this.config.networkForBuild,
        cacheDir,
        env: SANDBOX_ENV,
      });

      await this.checkCancelled();
      await this.setStatus('BASELINE', 'Recording baseline failures');
      await this.stage('baseline', 'Running install, build, and test on the untouched code');
      const runtime = await verifier.runtime();
      this.log(`Selected ${runtime.label} (from ${runtime.source})`, 'info', 'baseline');
      baseline = await verifier.verify({ clean: true });
      await this.deps.reporter.update({
        baseline: summarizeVerification(baseline),
        runtime: baseline.runtime,
      });
      await this.beat(baseline.score, `Baseline heartbeat ${baseline.score}`);

      await this.setStatus('DIAGNOSING', 'Diagnosing cause of death');
      await this.stage('diagnose', 'Classifying failures');
      for (const issue of baseline.issues) {
        this.deps.sink.emit({ type: 'issue', issue, message: issue.title });
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

      let state = baseline;
      if (baseline.issues.length > 0) {
        await this.setStatus('REPAIRING', 'Attempting resurrection');
        await this.stage('repair', 'Applying fixes one at a time, verifying each');
        state = await this.repairLoop(ws, eco, verifier, baseline, commit.date, cacheDir);
        const count = (s: string) => this.attempts.filter((a) => a.status === s).length;
        this.log(
          `Repair stage finished: ${count('VERIFIED')} verified, ${count('REVERTED')} reverted, ${count('ERROR')} errored, ${count('SUGGESTED')} suggested (unverified).`,
          'info',
          'repair',
        );
      }

      await this.checkCancelled();
      const finalRuntime = await verifier.runtime();
      staticIssues = await this.staticCiFixes(ws, analysis, finalRuntime.major);

      if (this.sm.status !== 'VERIFYING') await this.setStatus('VERIFYING', 'Final verification');
      await this.stage('finalize', 'Clean reinstall and final verification');
      const anyChange = ws.changes().some((c) => !c.path.startsWith('.github/'));
      final = anyChange || state !== baseline ? await verifier.verify({ clean: true }) : baseline;
      await this.deps.reporter.update({ final: summarizeVerification(final), runtime: final.runtime });
      await this.beat(final.score, `Final heartbeat ${final.score}`);
      warnings = [...new Set([...warnings, ...verifier.warnings])];
    } catch (err) {
      error = toResurrectionError(err);
      this.log(`${error.code}: ${error.message}`, 'error', 'engine');
    }

    // ------------------------------------------------------------ report (always)
    const cancelled = error?.code === 'CANCELLED';
    const notNode = error?.code === 'NOT_A_NODE_PROJECT';
    const changes = ws?.changes() ?? [];
    const patch = createGitPatch(changes);
    const health: Health = error && !notNode ? 'UNRECOVERABLE' : computeHealth(baseline, final);

    const report = buildReport({
      repo: {
        owner: input.repo.owner,
        name: input.repo.name,
        url: input.repo.url,
        commitSha: commit?.sha ?? null,
        commitDate: commit?.date ?? null,
      },
      health,
      ecosystem: eco?.id ?? null,
      analysis,
      baseline,
      final,
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
    } else if (error && !notNode) {
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
        heartbeat: final?.score ?? this.heartbeat,
        ...(notNode ? { errorCode: error!.code, errorMessage: error!.message } : {}),
      });
    }
    this.deps.sink.emit({ type: 'done', health, message: report.headline });
    await this.deps.sink.flush?.();
    return { status, health, report, patch, attempts: this.attempts, workspace: ws };
  }
}
