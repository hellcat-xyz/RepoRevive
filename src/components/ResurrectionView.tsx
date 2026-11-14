'use client';

import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { useState } from 'react';
import { ATTEMPT_META } from '@/lib/health';
import { AttemptCard } from './AttemptCard';
import { Celebration } from './Celebration';
import { Dashboard } from './Dashboard';
import { EcgMonitor } from './EcgMonitor';
import { GraveyardScene } from './GraveyardScene';
import { HealthBadge } from './HealthBadge';
import { StageTimeline } from './StageTimeline';
import { Terminal } from './Terminal';
import { useResurrection } from './useResurrection';

export function ResurrectionView({ id }: { id: string }) {
  const r = useResurrection(id);
  const [cancelling, setCancelling] = useState(false);
  const snap = r.snapshot;

  if (r.error) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-40 text-center">
        <p className="font-display text-2xl text-zinc-200">This grave is empty.</p>
        <p className="mt-2 text-zinc-500">{r.error}</p>
        <Link href="/" className="mt-6 inline-block text-ecto-300 hover:underline">
          ← Back to the graveyard
        </Link>
      </div>
    );
  }

  const failed = r.status === 'FAILED' || r.status === 'CANCELLED';
  const queued = r.status === 'QUEUED';
  const sorted = [...r.attempts].sort((a, b) => b.seq - a.seq);

  return (
    <div className="relative min-h-screen">
      <div className="absolute inset-x-0 top-0 h-[70vh] opacity-50">
        <GraveyardScene intensity={0.6} />
      </div>
      <Celebration
        show={r.finishedLive && (r.health === 'REVIVED' || r.health === 'PARTIALLY_REVIVED')}
        partial={r.health === 'PARTIALLY_REVIVED'}
      />

      <div className="relative mx-auto max-w-7xl px-4 pb-24 pt-24 sm:px-6">
        {/* header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        >
          <div className="min-w-0">
            <p className="eyebrow">Resurrection #{id.slice(-8)}</p>
            <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
              {snap ? (
                <a
                  href={snap.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-ecto-200"
                >
                  <span className="text-zinc-500">{snap.owner}/</span>
                  {snap.name}
                </a>
              ) : (
                <span className="inline-block h-9 w-64 animate-pulse rounded bg-white/5" />
              )}
            </h1>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-zinc-500">
              {snap?.commitSha && <span>commit {snap.commitSha.slice(0, 10)}</span>}
              {snap?.commitDate && <span>last breath {new Date(snap.commitDate).toLocaleDateString()}</span>}
              {snap?.runtime && <span>runtime {snap.runtime}</span>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <HealthBadge health={r.health} />
            {!r.finished && snap && (
              <button
                type="button"
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  await r.cancel();
                }}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-50"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </motion.div>

        {/* vitals */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="panel mt-6 p-4 sm:p-5"
        >
          <EcgMonitor heartbeat={r.heartbeat} health={r.health} className="h-36 sm:h-44" />
          <div className="mt-5">
            <StageTimeline current={r.stage} finished={r.finished} failed={failed} />
          </div>
          <AnimatePresence>
            {queued && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mt-4 text-sm text-zinc-400"
              >
                Waiting for a sandbox worker… If this never starts, make sure{' '}
                <span className="font-mono text-zinc-300">npm run worker</span> is running.
              </motion.p>
            )}
          </AnimatePresence>
          {failed && snap?.errorMessage && (
            <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200">
              <span className="font-mono text-xs">{snap.errorCode}</span> · {snap.errorMessage}
            </p>
          )}
        </motion.div>

        {/* live */}
        <div className="mt-6 grid gap-5 lg:grid-cols-5">
          <div className="h-[520px] lg:col-span-3">
            <Terminal lines={r.lines} live={r.live && !r.finished} />
          </div>
          <section
            className="panel flex h-[520px] flex-col p-4 lg:col-span-2"
            aria-labelledby="attempts-title"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 id="attempts-title" className="font-display text-base font-semibold text-zinc-100">
                Repair attempts
              </h2>
              <span className="font-mono text-xs text-zinc-500">{r.attempts.length}</span>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(['VERIFIED', 'VERIFIED_STATIC', 'REVERTED', 'SUGGESTED'] as const).map((s) => (
                <span
                  key={s}
                  title={ATTEMPT_META[s].explain}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ${ATTEMPT_META[s].className}`}
                >
                  {ATTEMPT_META[s].label}
                </span>
              ))}
            </div>
            <ul className="-mr-2 flex-1 space-y-2.5 overflow-y-auto pr-2">
              {sorted.length === 0 && (
                <li className="text-sm text-zinc-600">
                  No repairs yet. The patient is still being examined.
                </li>
              )}
              {sorted.map((a) => (
                <AttemptCard key={a.seq} attempt={snap?.attempts.find((x) => x.seq === a.seq) ?? a} />
              ))}
            </ul>
          </section>
        </div>

        {/* final dashboard */}
        {r.finished && snap?.report && (
          <div className="mt-10">
            <Dashboard id={id} report={snap.report} attempts={snap.attempts} hasPatch={snap.hasPatch} />
          </div>
        )}
      </div>
    </div>
  );
}
