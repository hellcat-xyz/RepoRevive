'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';
import type { AttemptRecord, StepName } from '@/engine/core/types';
import type { ResurrectionReport } from '@/engine/report';
import { HEALTH_META } from '@/lib/health';
import { DiffViewer } from './DiffViewer';

const STEPS: StepName[] = ['install', 'build', 'test'];

function StepPill({ status, skipReason }: { status?: string; skipReason?: string }) {
  if (!status) return <span className="text-zinc-600">—</span>;
  const map: Record<string, string> = {
    passed: 'bg-ecto-400/10 text-ecto-300 ring-ecto-400/30',
    failed: 'bg-rose-400/10 text-rose-300 ring-rose-400/30',
    timeout: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
    skipped: 'bg-white/[0.03] text-zinc-500 ring-white/10',
  };
  const label =
    status === 'skipped'
      ? skipReason === 'blocked'
        ? 'blocked'
        : skipReason === 'no-test-suite'
          ? 'no tests'
          : 'n/a'
      : status;
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider ring-1 ${map[status]}`}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  eyebrow,
  children,
  delay = 0,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay }}
      className="panel p-5 sm:p-6"
    >
      {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
      <h2 className="mb-4 font-display text-lg font-semibold tracking-tight text-zinc-100">{title}</h2>
      {children}
    </motion.section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-crypt-950/50 p-4">
      <p className={`font-display text-3xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-xs text-zinc-500">{label}</p>
    </div>
  );
}

export function Dashboard({
  id,
  report,
  attempts,
  hasPatch,
}: {
  id: string;
  report: ResurrectionReport;
  attempts: AttemptRecord[];
  hasPatch: boolean;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const meta = HEALTH_META[report.health];
  const verified = attempts.filter((a) => a.status === 'VERIFIED' || a.status === 'VERIFIED_STATIC');
  const reverted = attempts.filter((a) => a.status === 'REVERTED');
  const suggested = attempts.filter((a) => a.status === 'SUGGESTED');
  const patchName = `${report.repo.owner}-${report.repo.name}-revived.patch`;

  async function showPatch() {
    setLoadingPatch(true);
    try {
      const res = await fetch(`/api/resurrections/${id}/patch`);
      setPatch(res.ok ? await res.text() : '');
    } finally {
      setLoadingPatch(false);
    }
  }

  return (
    <div className="space-y-5">
      <motion.section
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className={`panel relative overflow-hidden p-6 sm:p-8 ring-1 ${meta.ring}`}
      >
        <div
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full blur-3xl"
          style={{ background: `${meta.stroke}22` }}
        />
        <p className="eyebrow">Resurrection report</p>
        <h2 className={`mt-2 font-display text-3xl font-bold tracking-tight sm:text-4xl ${meta.text}`}>
          {meta.label}
        </h2>
        <p className="mt-2 max-w-3xl text-zinc-300">{report.headline}</p>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Verified fixes kept" value={verified.length} tone="text-ecto-300" />
          <Stat label="Fixes reverted" value={reverted.length} tone="text-rose-300" />
          <Stat label="Unverified suggestions" value={suggested.length} tone="text-amber-300" />
          <Stat
            label={`Files · +${report.patch.additions} −${report.patch.deletions}`}
            value={report.patch.files}
            tone="text-spirit-300"
          />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {hasPatch ? (
            <a
              href={`/api/resurrections/${id}/patch`}
              download={patchName}
              className="inline-flex items-center gap-2 rounded-xl bg-ecto-400 px-5 py-2.5 font-display text-sm font-semibold text-crypt-950 shadow-[0_0_24px_-6px_rgba(74,222,128,0.8)] transition-colors hover:bg-ecto-300"
            >
              ⬇ Download verified .patch
            </a>
          ) : (
            <span className="inline-flex items-center rounded-xl border border-white/10 px-5 py-2.5 text-sm text-zinc-500">
              No verified changes to download
            </span>
          )}
          <a
            href={`/api/resurrections/${id}/report?format=md`}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-spirit-400/40 hover:text-spirit-200"
          >
            Report (.md)
          </a>
          <a
            href={`/api/resurrections/${id}/report?format=json`}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-spirit-400/40 hover:text-spirit-200"
          >
            Report (.json)
          </a>
        </div>
        {hasPatch && (
          <p className="mt-3 font-mono text-xs text-zinc-500">
            Apply locally: <span className="text-zinc-300">git apply {patchName}</span> · Nothing was pushed
            to GitHub.
          </p>
        )}
      </motion.section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Vital signs: before and after" eyebrow="Verification" delay={0.05}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="pb-2 font-normal">Step</th>
                  <th className="pb-2 font-normal">Baseline · {report.runtime.baseline ?? '—'}</th>
                  <th className="pb-2 font-normal">Final · {report.runtime.final ?? '—'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {STEPS.map((s) => {
                  const b = report.verification.baseline?.steps[s];
                  const f = report.verification.final?.steps[s];
                  return (
                    <tr key={s}>
                      <td className="py-2.5 font-mono text-zinc-300">{s}</td>
                      <td className="py-2.5">
                        <StepPill status={b?.status} skipReason={b?.skipReason} />
                      </td>
                      <td className="py-2.5">
                        <StepPill status={f?.status} skipReason={f?.skipReason} />
                        {f && f.durationMs > 0 && (
                          <span className="ml-2 font-mono text-[11px] text-zinc-600">
                            {(f.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.error && (
            <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200">
              <span className="font-mono text-xs">{report.error.code}</span> · {report.error.message}
            </p>
          )}
        </Section>

        <Section title="Cause of death" eyebrow="Diagnosis" delay={0.1}>
          {report.rootCauses.length === 0 ? (
            <p className="text-sm text-zinc-500">No failures were found.</p>
          ) : (
            <ul className="space-y-3">
              {report.rootCauses.map((c) => (
                <li key={`${c.kind}-${c.title}`} className="flex gap-3">
                  <span
                    className={`mt-0.5 font-mono ${c.resolved ? 'text-ecto-400' : 'text-amber-400'}`}
                    aria-label={c.resolved ? 'resolved' : 'unresolved'}
                  >
                    {c.resolved ? '✓' : '!'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200">
                      {c.title} <span className="font-mono text-[11px] text-zinc-500">· {c.step}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-zinc-400">{c.cause}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {(report.remainingIssues.length > 0 || report.recommendations.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-2">
          {report.remainingIssues.length > 0 && (
            <Section title="Still haunting this repository" eyebrow="Remaining problems" delay={0.15}>
              <ul className="space-y-3">
                {report.remainingIssues.map((r) => (
                  <li
                    key={`${r.kind}-${r.title}`}
                    className="rounded-lg border border-amber-400/15 bg-amber-400/[0.04] p-3"
                  >
                    <p className="text-sm font-medium text-amber-200">{r.title}</p>
                    <p className="mt-1 text-sm text-zinc-400">{r.advice}</p>
                    {r.evidence && (
                      <pre className="mt-2 max-h-32 overflow-auto rounded bg-crypt-950/70 p-2 font-mono text-[11px] leading-relaxed text-zinc-500">
                        {r.evidence}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {report.recommendations.length > 0 && (
            <Section title="Aftercare" eyebrow="Recommendations" delay={0.2}>
              <ul className="list-disc space-y-2 pl-5 text-sm text-zinc-300 marker:text-spirit-400">
                {report.recommendations.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}

      {report.dependencyChanges.length > 0 && (
        <Section title="Dependency changes" eyebrow="package.json" delay={0.2}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="pb-2 font-normal">Package</th>
                  <th className="pb-2 font-normal">Section</th>
                  <th className="pb-2 font-normal">From</th>
                  <th className="pb-2 font-normal">To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono text-[13px]">
                {report.dependencyChanges.map((d) => (
                  <tr key={`${d.section}-${d.name}`}>
                    <td className="py-2 text-zinc-200">{d.name}</td>
                    <td className="py-2 text-zinc-500">{d.section}</td>
                    <td className="py-2 text-rose-300/90">{d.from ?? '—'}</td>
                    <td className="py-2 text-ecto-300">{d.to ?? 'removed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {hasPatch && (
        <Section title="Complete verified diff" eyebrow="Patch" delay={0.25}>
          {patch === null ? (
            <button
              type="button"
              onClick={showPatch}
              disabled={loadingPatch}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-ecto-400/40 hover:text-ecto-200"
            >
              {loadingPatch ? 'Loading…' : 'View full diff'}
            </button>
          ) : (
            <DiffViewer diff={patch} />
          )}
        </Section>
      )}

      {report.warnings.length > 0 && (
        <Section title="Warnings" eyebrow="Deprecations & notes" delay={0.3}>
          <details>
            <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
              {report.warnings.length} warning(s)
            </summary>
            <ul className="mt-3 space-y-1.5 font-mono text-xs text-zinc-500">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        </Section>
      )}
    </div>
  );
}
