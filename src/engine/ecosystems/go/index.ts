import { createHash } from 'node:crypto';
import type { Issue, IssueKind, RuntimeSelection, StepName, StepResult } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import { languageCounts, listWorkflows, walkFiles } from '../shared';
import type { Ecosystem, EcosystemDetection, FixStrategy, ProjectAnalysis, StepPlan } from '../types';
import { goStrategies } from './strategies';

export const DEFAULT_GO_MINOR = 22;
export const MIN_GO_MINOR = 13;
const MAX_GO_MINOR = 30;

export interface GoMod {
  module: string | null;
  goDirective: string | null;
  toolchain: string | null;
  requires: { path: string; version: string; indirect: boolean }[];
  replaces: number;
}

/** Parse go.mod (module, go, toolchain, require blocks, replace count). Tolerant, comment-aware. */
export function parseGoMod(text: string): GoMod {
  const clean = text.replace(/\/\/[^\n]*$/gm, (m) => (m.includes('indirect') ? m : ''));
  const out: GoMod = { module: null, goDirective: null, toolchain: null, requires: [], replaces: 0 };
  out.module = /^\s*module\s+("?)([^\s"]+)\1/m.exec(clean)?.[2] ?? null;
  out.goDirective = /^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(clean)?.[1] ?? null;
  out.toolchain = /^\s*toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(clean)?.[1] ?? null;
  const req = (line: string) => {
    const m = /^\s*([^\s]+)\s+(v[^\s]+)(\s*\/\/\s*indirect)?/.exec(line);
    if (m) out.requires.push({ path: m[1]!, version: m[2]!, indirect: Boolean(m[3]) });
  };
  for (const block of clean.matchAll(/^\s*require\s*\(([\s\S]*?)^\s*\)/gm))
    block[1]!.split('\n').forEach(req);
  for (const m of clean.matchAll(/^\s*require\s+([^\s(][^\n]*)$/gm)) req(m[1]!);
  out.replaces = (clean.match(/^\s*replace\b/gm) ?? []).length;
  return out;
}

export function goMinor(version: string): number | null {
  const m = /^1\.(\d{1,2})(?:\.\d+)?$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

export function goRuntimeFor(minor: number, source: string, warnings: string[] = []): RuntimeSelection {
  return {
    family: 'go',
    version: `1.${minor}`,
    image: `golang:1.${minor}`,
    label: `Go 1.${minor}`,
    major: 1,
    source,
    warnings,
  };
}

/** `.go-version` > go.mod `toolchain` > go.mod `go` > default. Two-part "go 1.21" means the 1.21 toolchain. */
export function selectGoRuntime(decl: {
  goVersionFile: string | null;
  mod: GoMod | null;
  work: string | null;
}): RuntimeSelection {
  const warnings: string[] = [];
  const candidates: [string, string | null][] = [
    ['.go-version', decl.goVersionFile],
    ['go.mod toolchain', decl.mod?.toolchain ?? null],
    ['go.mod go', decl.mod?.goDirective ?? null],
    ['go.work', decl.work],
  ];
  for (const [source, v] of candidates) {
    if (!v) continue;
    const minor = goMinor(v.replace(/^go/, ''));
    if (minor === null || minor > MAX_GO_MINOR) {
      warnings.push(`Ignoring unrecognised Go version "${v}" in ${source}.`);
      continue;
    }
    if (minor < MIN_GO_MINOR) {
      warnings.push(`Go 1.${minor} (${source}) predates the images offered; using Go 1.${MIN_GO_MINOR}.`);
      return goRuntimeFor(MIN_GO_MINOR, source, warnings);
    }
    return goRuntimeFor(minor, source, warnings);
  }
  return goRuntimeFor(DEFAULT_GO_MINOR, `default (Go 1.${DEFAULT_GO_MINOR})`, warnings);
}

async function readGo(ws: Workspace) {
  const modText = await ws.current('go.mod');
  const workText = await ws.current('go.work');
  return {
    mod: modText === null ? null : parseGoMod(modText),
    work: workText ? (/^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(workText)?.[1] ?? null) : null,
    goVersionFile: (await ws.current('.go-version'))?.trim().replace(/^go/, '') || null,
    hasSum: await ws.exists('go.sum'),
    hasWork: workText !== null,
  };
}

function diagnoseGo(result: Pick<StepResult, 'step' | 'status' | 'logTail' | 'command'>): Issue[] {
  const log = result.logTail;
  const out: Issue[] = [];
  const add = (
    kind: IssueKind,
    fp: string,
    title: string,
    evidence: string,
    data: Record<string, string> = {},
    file?: string,
  ) => {
    if (out.some((o) => o.fingerprint === fp)) return;
    out.push({
      kind,
      fingerprint: fp,
      step: result.step,
      severity: 'error',
      title,
      evidence: evidence.slice(0, 500),
      data,
      diagnostic: { category: kind, message: title, command: result.command, ...(file ? { file } : {}) },
    });
  };
  if (result.status === 'timeout') {
    add('timeout', `timeout:${result.step}`, `The ${result.step} step timed out`, 'timeout');
    return out;
  }
  const first = (re: RegExp) => (log.split(/\r?\n/).find((l) => re.test(l)) ?? '').trim();

  const tool =
    /go\.mod requires go >= (\d+\.\d+(?:\.\d+)?)|requires go (\d+\.\d+(?:\.\d+)?) \(running go/i.exec(log);
  if (tool)
    add('toolchain-mismatch', 'toolchain-mismatch', `The module needs Go ${tool[1] ?? tool[2]}`, tool[0], {
      required: tool[1] ?? tool[2]!,
    });

  if (/SECURITY ERROR|checksum mismatch|verifying module:/i.test(log))
    // Possible tampering: never repaired automatically.
    add(
      'lockfile-corrupt',
      'lockfile-corrupt:go.sum',
      'go.sum checksum mismatch',
      first(/checksum|SECURITY/i),
    );
  if (
    /missing go\.sum entry|updates to go\.mod needed|go: updates to go\.sum needed|go\.sum is out of date/i.test(
      log,
    )
  )
    add('lockfile-drift', 'lockfile-drift', 'go.mod / go.sum are out of sync', first(/go\.sum|go\.mod/i));

  for (const m of log.matchAll(
    /(?:go: |^)([\w.\-/~]+(?:\.[\w-]+)+(?:\/[\w.\-~/]*)?)@(v[\w.+-]+): (?:reading [^\n]*: )?(?:404 Not Found|410 Gone|invalid version: unknown revision|module [^\n]*: no matching versions)/gm,
  ))
    add('missing-version', `missing-version:${m[1]}`, `Module ${m[1]}@${m[2]} cannot be fetched`, m[0], {
      module: m[1]!,
      version: m[2]!,
    });
  for (const m of log.matchAll(
    /(?:no required module provides package|cannot find package) "?([\w.\-/~]+)"?/g,
  ))
    add('missing-module', `missing-module:${m[1]}`, `No module provides package ${m[1]}`, m[0], {
      package: m[1]!,
    });
  if (/declares its path as|ambiguous import|conflicting versions/i.test(log))
    add(
      'dependency-conflict',
      'dependency-conflict',
      'Module path or import conflict',
      first(/declares its path|ambiguous import|conflicting/i),
    );

  const ce = /^(?:#[^\n]*\n)?\.?\/?([\w./-]+\.go):(\d+):(\d+): ([^\n]+)/m.exec(log);
  if (out.length === 0 && ce)
    add(
      'compile-error',
      `compile-error:${ce[1]}`,
      `Go compile error in ${ce[1]}`,
      ce[0],
      { file: ce[1]! },
      ce[1],
    );
  if (out.length === 0 && result.step === 'test' && /--- FAIL|^FAIL\b/m.test(log))
    add('test-failure', 'test-failure', 'Go tests failed', first(/FAIL/));
  if (out.length === 0 && /dial tcp|connection refused|i\/o timeout|TLS handshake timeout/i.test(log))
    add('network', 'network', 'Network error while fetching modules', first(/dial tcp|timeout|refused/i));
  if (out.length === 0)
    add(
      result.step === 'build' ? 'build-failure' : result.step === 'test' ? 'test-failure' : 'unknown',
      `${result.step}-failure`,
      `go ${result.step} failed`,
      first(/error|fail/i),
    );
  return out;
}

export async function detectGo(ws: Workspace): Promise<EcosystemDetection | null> {
  const g = await readGo(ws);
  if (!g.mod && !g.hasWork) return null;
  const evidence = [g.mod ? 'go.mod' : 'go.work'];
  let confidence = 0.85;
  if (g.hasSum) {
    evidence.push('go.sum');
    confidence = 0.95;
  }
  if (g.hasWork && g.mod) evidence.push('go.work');
  return { confidence, evidence };
}

const FINGERPRINT = ['go.mod', 'go.sum', 'go.work', 'go.work.sum', '.go-version'];

export const goEcosystem: Ecosystem = {
  id: 'go',
  displayName: 'Go modules',
  language: 'Go',
  family: 'go',
  supportsCiModernize: false,
  async detect(ws) {
    return ((await detectGo(ws))?.confidence ?? 0) >= 0.5;
  },
  detection: detectGo,
  sandboxEnv: () => ({
    GOTOOLCHAIN: 'local',
    GOPROXY: 'https://proxy.golang.org,direct',
    GOFLAGS: '-buildvcs=false',
    GONOSUMCHECK: '',
  }),

  async analyze(ws): Promise<ProjectAnalysis> {
    const g = await readGo(ws);
    const files = await walkFiles(ws);
    const tests = files.some((f) => f.endsWith('_test.go'));
    const warnings: string[] = [];
    if (g.mod && !g.hasSum && g.mod.requires.length)
      warnings.push('go.mod has requirements but there is no go.sum.');
    if (g.mod?.replaces) warnings.push(`${g.mod.replaces} replace directive(s) may point at local paths.`);
    const details: Record<string, string> = {};
    if (g.mod?.goDirective) details['go directive'] = g.mod.goDirective;
    if (g.mod?.toolchain) details['toolchain'] = g.mod.toolchain;
    if (g.hasWork) details['go.work'] = 'present';
    return {
      ecosystem: 'go',
      packageManager: 'go modules',
      projectName: g.mod?.module ?? null,
      description: null,
      dependencies: (g.mod?.requires ?? []).map((r) => ({
        name: r.path,
        range: r.version,
        section: r.indirect ? 'devDependencies' : 'dependencies',
      })),
      scripts: {},
      lockfiles: g.hasSum ? ['go.sum'] : [],
      lockfileVersion: null,
      runtimeDeclarations: [g.mod?.goDirective && { source: 'go.mod#go', value: g.mod.goDirective }].filter(
        (x): x is { source: string; value: string } => Boolean(x),
      ),
      hasBuild: true,
      hasTests: tests,
      testFramework: tests ? 'go test' : null,
      frameworks: ['gin-gonic/gin', 'labstack/echo', 'gofiber/fiber', 'spf13/cobra'].filter((n) =>
        g.mod?.requires.some((r) => r.path.includes(n)),
      ),
      languages: languageCounts(files, ['go', 'mod', 'sum']),
      fileCount: files.length,
      workflows: await listWorkflows(ws),
      isMonorepo: g.hasWork || files.filter((f) => f.endsWith('go.mod')).length > 1,
      details,
      warnings,
    };
  },

  async selectRuntime(ws) {
    const g = await readGo(ws);
    return selectGoRuntime({ goVersionFile: g.goVersionFile, mod: g.mod, work: g.work });
  },

  async plan(ws, _rt, timeouts: Record<StepName, number>): Promise<StepPlan[]> {
    const files = await walkFiles(ws);
    return [
      { step: 'install', command: ['go', 'mod', 'download'], network: 'bridge', timeoutMs: timeouts.install },
      { step: 'build', command: ['go', 'build', './...'], network: 'none', timeoutMs: timeouts.build },
      files.some((f) => f.endsWith('_test.go'))
        ? { step: 'test', command: ['go', 'test', './...'], network: 'none', timeoutMs: timeouts.test }
        : { step: 'test', command: null, skipReason: 'no-test-suite', network: 'none', timeoutMs: 0 },
    ];
  },

  async installFingerprint(ws, runtime) {
    const h = createHash('sha256').update(runtime.image);
    for (const f of FINGERPRINT) h.update(`\0${f}\0${(await ws.current(f).catch(() => null)) ?? '<none>'}`);
    return h.digest('hex');
  },
  async diagnose(result) {
    return diagnoseGo(result);
  },
  async staticIssues() {
    return [];
  },
  warningsFromLogs: () => [],
  async lockfileRegeneration(ws) {
    if (!(await ws.exists('go.mod'))) return null;
    return { lockfile: 'go.sum', extraFiles: ['go.mod'], command: ['go', 'mod', 'tidy'] };
  },
  strategies: goStrategies as FixStrategy[],
};

export { diagnoseGo };
