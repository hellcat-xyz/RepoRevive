import type { ResurrectionReport } from '../report';
import type { StepSummary } from '../report';
import { STEP_NAMES } from '../core/types';
import type { ExcludedChange } from './changes';

export const MAX_BODY_CHARS = 60_000;

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s)]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** Remove anything token-like from text that will be posted publicly. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

export function prTitle(report: Pick<ResurrectionReport, 'health' | 'ecosystem'>): string {
  return report.health === 'REVIVED'
    ? 'fix(revive): restore compatibility and build verification'
    : 'fix(revive): partially restore build compatibility';
}

const stepLine = (name: string, s: StepSummary | undefined): string => {
  if (!s) return `- ${name}: not run`;
  if (s.status === 'passed')
    return `- ${name}: passed${s.command ? ` (\`${s.command.slice(0, 120)}\`)` : ''}`;
  if (s.status === 'skipped')
    return `- ${name}: ${
      s.skipReason === 'no-test-suite'
        ? 'skipped, no test suite found'
        : s.skipReason === 'blocked'
          ? 'not run, blocked by an earlier failure'
          : 'not applicable'
    }`;
  return `- ${name}: ${s.status}`;
};

export interface PrBodyInput {
  report: ResurrectionReport;
  baseBranch: string;
  excluded: ExcludedChange[];
  reportUrl: string | null;
  jobId: string;
}

/** Public PR description. Contains no logs; only structured facts from the report. */
export function buildPrBody(i: PrBodyInput): string {
  const r = i.report;
  const L: string[] = [];
  L.push(
    '> **This pull request was generated automatically by [RepoRevive](https://github.com/hellcat-xyz/RepoRevive).** It is a draft. Review every change before merging.',
    '',
    '## Summary',
    '',
    r.headline,
    '',
    `- Repository: ${r.repo.owner}/${r.repo.name} (base \`${i.baseBranch}\` at \`${r.repo.commitSha?.slice(0, 12) ?? 'unknown'}\`)`,
    `- Ecosystem: ${r.analysis?.ecosystem ?? r.ecosystem ?? 'unknown'}${r.analysis?.packageManager ? ` (${r.analysis.packageManager})` : ''}`,
    `- Runtime: ${r.runtime.baseline ?? '-'} -> ${r.runtime.final ?? '-'}`,
    `- RepoRevive job: \`${i.jobId}\`${i.reportUrl ? ` ([report](${i.reportUrl}))` : ''}`,
    '',
  );
  if (r.rootCauses.length) {
    L.push('## Root causes found', '');
    for (const c of r.rootCauses.slice(0, 15))
      L.push(`- ${c.resolved ? 'Resolved' : 'Unresolved'}: ${c.title}. ${c.cause}`);
    L.push('');
  }
  const kept = r.attempts.filter((a) => a.status === 'VERIFIED' || a.status === 'VERIFIED_STATIC');
  L.push('## Accepted changes', '');
  for (const a of kept) {
    const label = a.status === 'VERIFIED' ? 'verified in the sandbox' : 'statically validated only';
    L.push(`- ${a.title} (${label}). Files: ${a.files.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (kept.length === 0) L.push('- None.');
  L.push('', '### Files modified', '');
  for (const f of r.modifiedFiles) L.push(`- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`);
  if (i.excluded.length) {
    L.push('', '### Not included in this pull request', '');
    for (const e of i.excluded) L.push(`- \`${e.path}\`: ${e.reason}`);
  }
  L.push(
    '',
    '## Verification',
    '',
    'Run by RepoRevive in an isolated container. This is **not** a GitHub Actions run.',
    '',
  );
  L.push('**Baseline (before)**');
  for (const s of STEP_NAMES) L.push(stepLine(s, r.verification.baseline?.steps[s]));
  L.push('', '**Final (after)**');
  for (const s of STEP_NAMES) L.push(stepLine(s, r.verification.final?.steps[s]));
  L.push('');
  if (r.coverage) {
    L.push(
      `Coverage: **${r.coverage.level}**${r.coverage.testedFunctionally ? '' : ' (behaviour not functionally tested)'}`,
    );
    for (const lim of r.coverage.limitations) L.push(`- ${lim}`);
    L.push('');
  }
  if (r.remainingIssues.length) {
    L.push('## Remaining issues', '');
    for (const x of r.remainingIssues.slice(0, 10)) L.push(`- ${x.title} (${x.step})`);
    L.push('');
  }
  if (r.warnings.length) {
    L.push('## Warnings', '');
    for (const w of r.warnings.slice(0, 8)) L.push(`- ${w}`);
    L.push('');
  }
  L.push(
    '## Security considerations',
    '',
    '- Dependency changes were resolved from public registries; review new or re-pinned versions.',
    '- Repository code ran only in an isolated, resource-limited container with no GitHub credentials.',
    '- Workflow files and credentials are never modified by this pull request.',
    '',
  );
  return redactSecrets(L.join('\n')).slice(0, MAX_BODY_CHARS);
}
