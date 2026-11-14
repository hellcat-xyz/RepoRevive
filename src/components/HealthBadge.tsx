'use client';

import { motion } from 'framer-motion';
import type { Health } from '@/engine/core/types';
import { HEALTH_META } from '@/lib/health';

export function HealthBadge({ health, size = 'md' }: { health: Health; size?: 'sm' | 'md' }) {
  const m = HEALTH_META[health];
  const pulsing = health === 'DIAGNOSING' || health === 'REPAIRING';
  return (
    <motion.span
      role="status"
      aria-label={`Health: ${m.label}`}
      title={m.description}
      key={health}
      initial={{ scale: 0.92 }}
      animate={{ scale: 1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 18 }}
      className={`relative inline-flex items-center gap-2 overflow-hidden rounded-full ring-1 transition-colors duration-500 ${m.bg} ${m.ring} ${m.text} ${
        size === 'sm' ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
      } font-mono uppercase tracking-[0.14em]`}
    >
      <span className="relative flex h-2 w-2">
        {pulsing && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: m.stroke }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: m.stroke, boxShadow: `0 0 8px ${m.stroke}` }}
        />
      </span>
      <span>{m.label}</span>
    </motion.span>
  );
}
