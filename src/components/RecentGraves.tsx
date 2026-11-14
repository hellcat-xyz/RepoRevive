'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { HEALTH_META } from '@/lib/health';
import type { JobSummary } from '@/lib/types';

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function RecentGraves() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/resurrections', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((b: { jobs: JobSummary[] }) => alive && setJobs(b.jobs))
        .catch(() => alive && setError(true));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error && !jobs)
    return (
      <p className="text-center text-sm text-zinc-600">
        The graveyard ledger is unavailable (is the database running?).
      </p>
    );
  if (!jobs) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-t-[999px] rounded-b-xl bg-white/[0.03]" />
        ))}
      </div>
    );
  }
  if (jobs.length === 0)
    return <p className="text-center text-sm text-zinc-500">No graves disturbed yet. Be the first.</p>;

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {jobs.map((j, i) => {
        const m = HEALTH_META[j.health];
        const alive = j.health === 'REVIVED' || j.health === 'PARTIALLY_REVIVED';
        return (
          <motion.li
            key={j.id}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.04, duration: 0.4 }}
          >
            <Link
              href={`/r/${j.id}`}
              className="group relative block h-full rounded-b-xl rounded-t-[999px] border border-white/[0.06] bg-gradient-to-b from-crypt-700/70 to-crypt-900/90 px-4 pb-4 pt-10 text-center transition-all duration-300 hover:-translate-y-1 hover:border-white/15"
            >
              {alive && (
                <span
                  className="pointer-events-none absolute inset-x-6 -top-2 h-10 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                  style={{ background: m.stroke }}
                />
              )}
              <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                R.I.P.
              </span>
              <span className="mt-2 block truncate font-display text-sm text-zinc-500">{j.owner}</span>
              <span className="block truncate font-display text-base font-semibold text-zinc-100">
                {j.name}
              </span>
              <span
                className={`mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${m.text}`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: m.stroke, boxShadow: `0 0 6px ${m.stroke}` }}
                />
                {m.label}
              </span>
              <span className="mt-1 block font-mono text-[10px] text-zinc-600">{timeAgo(j.createdAt)}</span>
            </Link>
          </motion.li>
        );
      })}
    </ul>
  );
}
