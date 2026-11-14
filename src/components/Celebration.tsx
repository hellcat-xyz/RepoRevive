'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';

/** One-shot "It's alive!" moment when a job finishes as REVIVED. */
export function Celebration({ show, partial = false }: { show: boolean; partial?: boolean }) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!show) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [show]);

  const sparks = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => {
        const angle = (i / 28) * Math.PI * 2;
        const dist = 140 + ((i * 37) % 120);
        return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist * 0.7, d: 0.6 + ((i * 13) % 10) / 20 };
      }),
    [],
  );

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.6 } }}
          aria-hidden="true"
        >
          <motion.div
            className="absolute h-72 w-72 rounded-full bg-ecto-400/30 blur-3xl"
            initial={{ scale: 0.2, opacity: 0.9 }}
            animate={{ scale: 2.4, opacity: 0 }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
          />
          {!reduced &&
            sparks.map((s, i) => (
              <motion.span
                key={i}
                className="absolute h-1.5 w-1.5 rounded-full bg-ecto-300 shadow-[0_0_12px_4px_rgba(74,222,128,0.7)]"
                initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                animate={{ x: s.x, y: s.y, opacity: 0, scale: 0.4 }}
                transition={{ duration: s.d + 0.4, ease: 'easeOut' }}
              />
            ))}
          <motion.p
            className="text-glow font-display text-5xl font-bold tracking-tight text-ecto-300 sm:text-7xl"
            initial={{ scale: 0.6, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 220, damping: 14 }}
          >
            {partial ? 'It stirs…' : "It's alive!"}
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
