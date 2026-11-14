'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';
import type { AttemptRecord } from '@/engine/core/types';
import { ATTEMPT_META } from '@/lib/health';
import { DiffViewer } from './DiffViewer';

const STEP_ICON: Record<string, string> = { passed: '●', failed: '✕', timeout: '◷', skipped: '○' };
const STEP_CLASS: Record<string, string> = {
  passed: 'text-ecto-400',
  failed: 'text-rose-400',
  timeout: 'text-amber-400',
  skipped: 'text-zinc-600',
};

export function AttemptCard({ attempt }: { attempt: AttemptRecord }) {
  const [open, setOpen] = useState(false);
  const meta = ATTEMPT_META[attempt.status];
  const kept = attempt.status === 'VERIFIED' || attempt.status === 'VERIFIED_STATIC';
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={`rounded-xl border bg-crypt-900/60 ${kept ? 'border-ecto-400/20' : 'border-white/[0.06]'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className="mt-0.5 font-mono text-xs text-zinc-600">#{attempt.seq}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ${meta.className}`}
              title={meta.explain}
            >
              {meta.label}
            </span>
            <span className="font-medium text-zinc-100">{attempt.title}</span>
          </span>
          {attempt.reason && <span className="mt-1 block text-sm text-zinc-400">{attempt.reason}</span>}
          {attempt.verification && (
            <span className="mt-2 flex flex-wrap gap-3 font-mono text-[11px]">
              {(['install', 'build', 'test'] as const).map((s) => {
                const st = attempt.verification!.steps[s];
                return (
                  <span key={s} className={STEP_CLASS[st.status]}>
                    {STEP_ICON[st.status]} {s}
                    {st.status === 'skipped' && st.skipReason !== 'blocked' ? ' n/a' : ''}
                  </span>
                );
              })}
              <span className="text-zinc-500">· {attempt.verification.runtime}</span>
            </span>
          )}
        </span>
        <span
          className={`mt-1 text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/[0.06] p-4">
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-300">{attempt.rationale}</p>
          <p className="text-xs text-zinc-500">{meta.explain}</p>
          {attempt.diff ? (
            <DiffViewer diff={attempt.diff} />
          ) : (
            attempt.files.length > 0 && (
              <p className="font-mono text-xs text-zinc-500">{attempt.files.join(', ')}</p>
            )
          )}
        </div>
      )}
    </motion.li>
  );
}
