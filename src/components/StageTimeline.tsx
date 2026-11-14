'use client';

import { motion } from 'framer-motion';
import type { StageName } from '@/engine/core/types';
import { STAGES } from '@/lib/health';

export function StageTimeline({
  current,
  finished,
  failed,
}: {
  current: StageName | null;
  finished: boolean;
  failed: boolean;
}) {
  const currentIdx = current ? STAGES.findIndex((s) => s.id === current) : -1;
  return (
    <ol className="grid grid-cols-7 gap-1.5" aria-label="Resurrection stages">
      {STAGES.map((s, i) => {
        const done = finished && !failed ? true : i < currentIdx;
        const active = !finished && i === currentIdx;
        const broken = failed && i === currentIdx;
        return (
          <li key={s.id} className="min-w-0" aria-current={active ? 'step' : undefined}>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <motion.div
                className={`absolute inset-y-0 left-0 rounded-full ${broken ? 'bg-rose-400' : 'bg-ecto-400'}`}
                initial={false}
                animate={{ width: done || broken ? '100%' : active ? '55%' : '0%' }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                style={{ boxShadow: done || active ? '0 0 10px rgba(74,222,128,0.6)' : undefined }}
              />
              {active && <div className="absolute inset-0 animate-pulse bg-ecto-400/20" />}
            </div>
            <p
              className={`mt-2 truncate font-mono text-[10px] uppercase tracking-[0.14em] ${active ? 'text-ecto-300' : done ? 'text-zinc-400' : broken ? 'text-rose-300' : 'text-zinc-600'}`}
            >
              {s.label}
            </p>
            <p className="hidden truncate text-[11px] text-zinc-600 lg:block">{s.hint}</p>
          </li>
        );
      })}
    </ol>
  );
}
