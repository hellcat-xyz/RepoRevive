'use client';

import { ECOSYSTEM_LABEL } from '@/lib/ecosystems';
import type { JobSnapshot } from '@/lib/types';

const STEPS = ['install', 'build', 'test'] as const;

const statusClass: Record<string, string> = {
  passed: 'text-ecto-300',
  failed: 'text-rose-300',
  timeout: 'text-rose-300',
  skipped: 'text-zinc-400',
};

function stepLabel(s?: { status: string; skipReason?: string }): string {
  if (!s) return 'not run yet';
  if (s.status !== 'skipped') return s.status;
  return s.skipReason === 'no-test-suite' ? 'no test suite' : s.skipReason === 'blocked' ? 'blocked' : 'n/a';
}

/** Detected ecosystem, runtime, exact verification commands, and baseline vs final results. */
export function EcosystemPanel({ snap }: { snap: JobSnapshot }) {
  if (!snap.ecosystem && !snap.analysis) return null;
  const a = snap.analysis;
  const base = snap.baseline?.steps;
  const fin = snap.report?.verification.final?.steps;
  const cov = snap.report?.coverage;
  const ecoName = snap.ecosystem ? (ECOSYSTEM_LABEL[snap.ecosystem] ?? snap.ecosystem) : 'Unknown';

  return (
    <section className="panel mt-6 p-4 sm:p-5" aria-labelledby="eco-title">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h2 id="eco-title" className="font-display text-base font-semibold text-zinc-100">
          Detected project
        </h2>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-zinc-500">Language</dt>
            <dd className="font-mono text-zinc-200">{ecoName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-500">Package manager</dt>
            <dd className="font-mono text-zinc-200">
              {snap.packageManager ?? a?.packageManager ?? 'unknown'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-500">Runtime</dt>
            <dd className="font-mono text-zinc-200">
              {snap.report?.runtime.final ?? snap.runtime ?? 'selecting…'}
            </dd>
          </div>
        </dl>
      </div>
      {a?.details && Object.keys(a.details).length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-400">
          {Object.entries(a.details).map(([k, v]) => (
            <li key={k} className="rounded-md bg-white/[0.04] px-2 py-0.5">
              <span className="text-zinc-500">{k}:</span> <span className="font-mono">{v}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <caption className="sr-only">Verification commands with baseline and final results</caption>
          <thead className="text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th scope="col" className="pb-2 pr-3 font-medium">
                Step
              </th>
              <th scope="col" className="pb-2 pr-3 font-medium">
                Command
              </th>
              <th scope="col" className="pb-2 pr-3 font-medium">
                Baseline
              </th>
              <th scope="col" className="pb-2 font-medium">
                Final
              </th>
            </tr>
          </thead>
          <tbody className="align-top">
            {STEPS.map((s) => {
              const b = base?.[s];
              const f = fin?.[s];
              const cmd = (f ?? b)?.command;
              return (
                <tr key={s} className="border-t border-white/5">
                  <th scope="row" className="py-2 pr-3 font-mono text-zinc-300">
                    {s}
                  </th>
                  <td className="max-w-[26rem] break-words py-2 pr-3 font-mono text-xs text-zinc-400">
                    {cmd ?? '—'}
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono text-xs ${statusClass[b?.status ?? ''] ?? 'text-zinc-500'}`}
                  >
                    {stepLabel(b)}
                  </td>
                  <td className={`py-2 font-mono text-xs ${statusClass[f?.status ?? ''] ?? 'text-zinc-500'}`}>
                    {snap.report ? stepLabel(f) : '…'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {cov && (
        <p className="mt-3 text-sm text-zinc-300" data-testid="coverage">
          <span className="text-zinc-500">Verification coverage:</span>{' '}
          <span className={cov.testedFunctionally ? 'text-ecto-300' : 'text-amber-300'}>{cov.level}</span>
          {cov.limitations.length > 0 && (
            <span className="text-zinc-400"> · {cov.limitations.join(' ')}</span>
          )}
        </p>
      )}
      {snap.report?.warnings.some((w) => w.startsWith('Ambiguous ecosystem')) && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200">
          {snap.report.warnings.find((w) => w.startsWith('Ambiguous ecosystem'))}
        </p>
      )}
    </section>
  );
}
