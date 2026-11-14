import { createFilePatch, patchStats } from './core/patch';
import type {
  AttemptRecord,
  Health,
  Issue,
  IssueKind,
  StepName,
  StepResult,
  VerificationResult,
} from './core/types';
import { STEP_NAMES } from './core/types';
import type { FileChange } from './core/workspace';
import { allStepsOk } from './core/verification';
import type { ProjectAnalysis } from './ecosystems/types';
import { DEP_SECTIONS, parseManifest } from './ecosystems/npm/manifest';
import { ISSUE_EXPLANATIONS } from './explanations';

export interface StepSummary {
  status: StepResult['status'];
  skipReason?: StepResult['skipReason'];
  command?: string;
  durationMs: number;
  logTail: string;
}

export interface ReportVerification {
  runtime: string;
  score: number;
  steps: Record<StepName, StepSummary>;
}

export interface DependencyChange {
  name: string;
  section: string;
  from: string | null;
  to: string | null;
  change: 'added' | 'removed' | 'changed';
}

export interface ResurrectionReport {
  version: 1;
  generatedAt: string;
  repo: { owner: string; name: string; url: string; commitSha: string | null; commitDate: string | null };
  health: Health;
  headline: string;
  ecosystem: string | null;
  runtime: { baseline: string | null; final: string | null };
  analysis: ProjectAnalysis | null;
  rootCauses: {
    kind: IssueKind;
    title: string;
    step: string;
    cause: string;
    evidence: string;
    resolved: boolean;
  }[];
  attempts: AttemptRecord[];
  modifiedFiles: {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions: number;
    deletions: number;
  }[];
  dependencyChanges: DependencyChange[];
  verification: { baseline: ReportVerification | null; final: ReportVerification | null };
  remainingIssues: { kind: IssueKind; title: string; step: string; advice: string; evidence: string }[];
  warnings: string[];
  recommendations: string[];
  patch: { files: number; additions: number; deletions: number };
  durationMs: number;
  error?: { code: string; message: string };
}

const LOG_TAIL_LINES = 60;

export function summarizeVerification(v: VerificationResult | null): ReportVerification | null {
  if (!v) return null;
  const steps = {} as Record<StepName, StepSummary>;
  for (const s of STEP_NAMES) {
    const r = v.steps[s];
    steps[s] = {
      status: r.status,
      skipReason: r.skipReason,
      command: r.command,
      durationMs: r.durationMs,
      logTail: r.logTail.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n'),
    };
  }
  return { runtime: v.runtime, score: v.score, steps };
}

export function dependencyChanges(before: string | null, after: string | null): DependencyChange[] {
  const a = before ? parseManifest(before)?.json : undefined;
  const b = after ? parseManifest(after)?.json : undefined;
  if (!a || !b) return [];
  const out: DependencyChange[] = [];
  for (const section of DEP_SECTIONS) {
    const x = (a[section] ?? {}) as Record<string, string>;
    const y = (b[section] ?? {}) as Record<string, string>;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const from = typeof x[name] === 'string' ? x[name]! : null;
      const to = typeof y[name] === 'string' ? y[name]! : null;
      if (from === to) continue;
      out.push({
        name,
        section,
        from,
        to,
        change: from === null ? 'added' : to === null ? 'removed' : 'changed',
      });
    }
  }
  return out.sort((p, q) => p.name.localeCompare(q.name));
}

export interface BuildReportInput {
  repo: ResurrectionReport['repo'];
  health: Health;
  ecosystem: string | null;
  analysis: ProjectAnalysis | null;
  baseline: VerificationResult | null;
  final: VerificationResult | null;
  staticIssues: Issue[];
  attempts: AttemptRecord[];
  changes: FileChange[];
  patch: string;
  warnings: string[];
  durationMs: number;
  now: Date;
  error?: { code: string; message: string };
}

function headlineFor(
  health: Health,
  attempts: AttemptRecord[],
  baselineOk: boolean,
  error?: { message: string },
): string {
  const verified = attempts.filter((a) => a.status === 'VERIFIED' || a.status === 'VERIFIED_STATIC').length;
  const ci = attempts.some((a) => a.status === 'VERIFIED_STATIC');
  switch (health) {
    case 'REVIVED':
      return baselineOk
        ? `This repository was never dead: it installs, builds, and tests cleanly as-is.${ci ? ' Its CI configuration was modernized.' : ''}`
        : `Revived. ${verified} verified fix${verified === 1 ? '' : 'es'} brought every step back to life.`;
    case 'PARTIALLY_REVIVED':
      return `Partially revived. ${verified} verified fix${verified === 1 ? '' : 'es'} improved the repository, but some steps still fail.`;
    default:
      return error
        ? `Resurrection failed: ${error.message}`
        : 'Unrecoverable automatically. See the remaining issues for manual next steps.';
  }
}

export function buildReport(input: BuildReportInput): ResurrectionReport {
  const { baseline, final } = input;
  const finalFingerprints = new Set(final?.issues.map((i) => i.fingerprint) ?? []);
  const baselineIssues = [...(baseline?.issues ?? []), ...input.staticIssues];
  const seen = new Set<string>();
  const rootCauses = baselineIssues
    .filter((i) => (seen.has(i.fingerprint) ? false : (seen.add(i.fingerprint), true)))
    .map((i) => ({
      kind: i.kind,
      title: i.title,
      step: i.step,
      cause: ISSUE_EXPLANATIONS[i.kind].cause,
      evidence: i.evidence,
      resolved:
        i.kind === 'outdated-ci'
          ? input.attempts.some((a) => a.fingerprint === i.fingerprint && a.status === 'VERIFIED_STATIC')
          : !finalFingerprints.has(i.fingerprint) && final !== null,
    }));

  const modifiedFiles = input.changes.map((c) => {
    const s = patchStats(createFilePatch(c));
    return {
      path: c.path,
      status:
        c.before === null
          ? ('added' as const)
          : c.after === null
            ? ('deleted' as const)
            : ('modified' as const),
      additions: s.additions,
      deletions: s.deletions,
    };
  });

  const pkg = input.changes.find((c) => c.path === 'package.json');
  const remainingIssues = (final?.issues ?? []).map((i) => ({
    kind: i.kind,
    title: i.title,
    step: i.step,
    advice: ISSUE_EXPLANATIONS[i.kind].advice,
    evidence: i.evidence,
  }));

  const recommendations: string[] = [];
  const finalMajor = Number(/node:(\d+)/.exec(final?.runtime ?? '')?.[1] ?? NaN);
  if (!Number.isNaN(finalMajor) && finalMajor < 18) {
    recommendations.push(
      `The project now works on Node.js ${finalMajor}, which is end-of-life. Plan an upgrade path to a maintained LTS.`,
    );
  }
  if (input.attempts.some((a) => a.strategyId === 'npmrc-legacy-peer-deps' && a.status === 'VERIFIED')) {
    recommendations.push(ISSUE_EXPLANATIONS['peer-conflict'].advice);
  }
  if (input.analysis && !input.analysis.hasTests) {
    recommendations.push(
      'The project has no test suite, so verification could only check install and build. Add tests to protect future changes.',
    );
  }
  for (const r of remainingIssues) if (!recommendations.includes(r.advice)) recommendations.push(r.advice);

  return {
    version: 1,
    generatedAt: input.now.toISOString(),
    repo: input.repo,
    health: input.health,
    headline: headlineFor(
      input.health,
      input.attempts,
      baseline !== null && allStepsOk(baseline),
      input.error,
    ),
    ecosystem: input.ecosystem,
    runtime: { baseline: baseline?.runtime ?? null, final: final?.runtime ?? null },
    analysis: input.analysis,
    rootCauses,
    attempts: input.attempts,
    modifiedFiles,
    dependencyChanges: dependencyChanges(pkg?.before ?? null, pkg?.after ?? null),
    verification: { baseline: summarizeVerification(baseline), final: summarizeVerification(final) },
    remainingIssues,
    warnings: input.warnings,
    recommendations,
    patch: patchStats(input.patch),
    durationMs: input.durationMs,
    error: input.error,
  };
}

const STATUS_ICON: Record<string, string> = { passed: '✅', failed: '❌', timeout: '⏱️', skipped: '⏭️' };

export function reportToMarkdown(r: ResurrectionReport): string {
  const L: string[] = [];
  L.push(`# RepoRevive report: ${r.repo.owner}/${r.repo.name}`, '');
  L.push(`**Health:** ${r.health.replace('_', ' ')}  `);
  L.push(
    `**Commit:** ${r.repo.commitSha ?? 'unknown'}${r.repo.commitDate ? ` (${r.repo.commitDate.slice(0, 10)})` : ''}  `,
  );
  L.push(`**Runtime:** ${r.runtime.baseline ?? '-'} → ${r.runtime.final ?? '-'}  `);
  L.push(`**Generated:** ${r.generatedAt}`, '', `> ${r.headline}`, '');

  L.push('## Verification', '', '| Step | Baseline | Final |', '|---|---|---|');
  for (const s of STEP_NAMES) {
    const b = r.verification.baseline?.steps[s];
    const f = r.verification.final?.steps[s];
    const cell = (x?: StepSummary) =>
      x ? `${STATUS_ICON[x.status]} ${x.status}${x.skipReason ? ` (${x.skipReason})` : ''}` : '-';
    L.push(`| ${s} | ${cell(b)} | ${cell(f)} |`);
  }
  L.push('');

  if (r.rootCauses.length) {
    L.push('## What killed it', '');
    for (const c of r.rootCauses)
      L.push(`- ${c.resolved ? '✅' : '⚠️'} **${c.title}** (${c.step}). ${c.cause}`);
    L.push('');
  }

  L.push('## Repair attempts', '');
  if (!r.attempts.length) L.push('No repairs were needed or attempted.');
  for (const a of r.attempts) {
    L.push(`### ${a.seq}. ${a.title} — \`${a.status}\``, '', a.rationale, '');
    if (a.reason) L.push(`_Verification:_ ${a.reason}`, '');
    if (a.files.length) L.push(`Files: ${a.files.map((f) => `\`${f}\``).join(', ')}`, '');
  }

  if (r.dependencyChanges.length) {
    L.push('## Dependency changes', '', '| Package | Section | From | To |', '|---|---|---|---|');
    for (const d of r.dependencyChanges)
      L.push(`| ${d.name} | ${d.section} | ${d.from ?? '—'} | ${d.to ?? '—'} |`);
    L.push('');
  }

  if (r.modifiedFiles.length) {
    L.push('## Modified files', '');
    for (const f of r.modifiedFiles) L.push(`- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`);
    L.push('');
  }

  if (r.remainingIssues.length) {
    L.push('## Remaining issues', '');
    for (const i of r.remainingIssues) L.push(`- **${i.title}** (${i.step}). ${i.advice}`);
    L.push('');
  }
  if (r.recommendations.length) {
    L.push('## Recommendations', '');
    for (const x of r.recommendations) L.push(`- ${x}`);
    L.push('');
  }
  if (r.warnings.length) {
    L.push('## Warnings', '');
    for (const w of r.warnings.slice(0, 40)) L.push(`- ${w}`);
    L.push('');
  }
  L.push(
    '---',
    '',
    'Only fixes marked `VERIFIED` or `VERIFIED_STATIC` are included in the patch. Apply it with `git apply <file>.patch`.',
  );
  return L.join('\n') + '\n';
}
