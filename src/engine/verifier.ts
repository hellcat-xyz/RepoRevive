import type { EventSink, Sandbox } from './core/ports';
import type { Issue, RuntimeSelection, StepName, StepResult, VerificationResult } from './core/types';
import { STEP_NAMES } from './core/types';
import { scoreSteps, uniqueIssues } from './core/verification';
import type { Workspace } from './core/workspace';
import type { Ecosystem } from './ecosystems/types';

export interface VerifierOptions {
  timeouts: Record<StepName, number>;
  networkForBuild: boolean;
  cacheDir: string;
  /** Extra env for every sandbox command (allow-listed, no secrets). */
  env?: Record<string, string>;
}

export interface VerifyOptions {
  /** Force a fresh dependency install even if inputs are unchanged. */
  clean?: boolean;
  label?: string;
}

export interface Verification extends VerificationResult {
  runtimeSelection: RuntimeSelection;
  warnings: string[];
}

/** Runs install/build/test for the current workspace state and diagnoses failures. */
export class Verifier {
  private lastInstall: { fingerprint: string; result: StepResult } | null = null;
  readonly warnings = new Set<string>();

  constructor(
    private readonly ws: Workspace,
    private readonly eco: Ecosystem,
    private readonly sandbox: Sandbox,
    private readonly sink: EventSink,
    private readonly opts: VerifierOptions,
  ) {}

  async runtime(): Promise<RuntimeSelection> {
    return this.eco.selectRuntime(this.ws);
  }

  async verify(o: VerifyOptions = {}): Promise<Verification> {
    const runtime = await this.runtime();
    for (const w of runtime.warnings) this.warnings.add(w);
    await this.sandbox.ensureImage(runtime.image, (line) =>
      this.sink.emit({ type: 'log', level: 'debug', message: line, source: 'docker' }),
    );
    const plan = await this.eco.plan(this.ws, runtime, this.opts.timeouts);
    const fingerprint = await this.eco.installFingerprint(this.ws, runtime);
    const steps = {} as Record<StepName, StepResult>;

    for (const name of STEP_NAMES) {
      const p = plan.find((x) => x.step === name)!;
      if (!p.command) {
        steps[name] = {
          step: name,
          status: 'skipped',
          skipReason: p.skipReason ?? 'not-applicable',
          durationMs: 0,
          logTail: '',
        };
        continue;
      }
      if (name !== 'install' && steps.install.status !== 'passed') {
        steps[name] = {
          step: name,
          status: 'skipped',
          skipReason: 'blocked',
          durationMs: 0,
          logTail: 'Skipped: install failed.',
        };
        continue;
      }
      if (
        name === 'install' &&
        !o.clean &&
        this.lastInstall?.fingerprint === fingerprint &&
        this.lastInstall.result.status === 'passed'
      ) {
        steps.install = this.lastInstall.result;
        this.sink.emit({
          type: 'log',
          level: 'info',
          message: 'Dependencies unchanged; reusing installed node_modules.',
          source: 'install',
        });
        continue;
      }
      steps[name] = await this.runStep(
        name,
        p.command,
        p.network === 'none' && this.opts.networkForBuild ? 'bridge' : p.network,
        p.timeoutMs,
        runtime,
      );
      if (name === 'install') {
        let r = steps.install;
        const issues = r.status === 'failed' ? await this.eco.diagnose(r, { ws: this.ws, runtime }) : [];
        if (issues.length > 0 && issues.every((i) => i.kind === 'network')) {
          this.sink.emit({
            type: 'log',
            level: 'warn',
            message: 'Network error during install; retrying once.',
            source: 'install',
          });
          r = await this.runStep(name, p.command, p.network, p.timeoutMs, runtime);
          steps.install = r;
        }
        for (const w of this.eco.warningsFromLogs(r.logTail)) this.warnings.add(`Deprecated: ${w}`);
        this.lastInstall = { fingerprint, result: r };
      }
    }

    const issues: Issue[] = [];
    for (const name of STEP_NAMES) {
      const r = steps[name];
      if (r.status === 'failed' || r.status === 'timeout')
        issues.push(...(await this.eco.diagnose(r, { ws: this.ws, runtime })));
    }
    issues.push(...(await this.eco.staticIssues(this.ws)));

    return {
      runtime: runtime.image,
      runtimeSelection: runtime,
      steps,
      issues: uniqueIssues(issues),
      score: scoreSteps(steps),
      warnings: [...this.warnings],
    };
  }

  private async runStep(
    step: StepName,
    command: string[],
    network: 'none' | 'bridge',
    timeoutMs: number,
    runtime: RuntimeSelection,
  ): Promise<StepResult> {
    const display = command[0] === 'sh' ? command.slice(2).join(' ') : command.join(' ');
    this.sink.emit({
      type: 'log',
      level: 'info',
      message: `$ ${display}   (${runtime.label}, network: ${network})`,
      source: step,
    });
    const res = await this.sandbox.run(
      {
        image: runtime.image,
        command,
        workdir: this.ws.root,
        cacheDir: this.opts.cacheDir,
        network,
        timeoutMs,
        env: this.opts.env,
        label: step,
      },
      (line) => this.sink.emit({ type: 'log', level: 'debug', message: line, source: step }),
    );
    // Commands such as `npm install` may rewrite tracked files; restore the engine's view.
    await this.ws.restoreTracked();
    const status = res.timedOut ? 'timeout' : res.exitCode === 0 ? 'passed' : 'failed';
    this.sink.emit({
      type: 'log',
      level: status === 'passed' ? 'success' : 'error',
      message: `${step} ${status}${status === 'failed' ? ` (exit ${res.exitCode})` : ''} in ${(res.durationMs / 1000).toFixed(1)}s`,
      source: step,
    });
    return {
      step,
      status,
      command: display,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      logTail: res.output,
    };
  }
}
