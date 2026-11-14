'use client';

import { useEffect, useRef } from 'react';
import type { Health } from '@/engine/core/types';
import { HEALTH_META } from '@/lib/health';

/** PQRST waveform sample at phase t in [0,1). Returns -1..1 (up is positive). */
function pqrst(t: number): number {
  const g = (mu: number, sigma: number, a: number) => a * Math.exp(-((t - mu) ** 2) / (2 * sigma ** 2));
  return (
    g(0.18, 0.025, 0.12) +
    g(0.36, 0.009, -0.14) +
    g(0.4, 0.011, 1) +
    g(0.44, 0.01, -0.28) +
    g(0.66, 0.045, 0.24)
  );
}

function noise(x: number) {
  return Math.sin(x * 12.9898) * 0.5 + Math.sin(x * 4.1414) * 0.5;
}

/**
 * Hospital-style sweeping monitor. heartbeat 0 = flatline; higher values beat faster and stronger.
 */
export function EcgMonitor({
  heartbeat,
  health,
  className = '',
}: {
  heartbeat: number;
  health: Health;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ heartbeat, health });
  useEffect(() => {
    stateRef.current = { heartbeat, health };
  }, [heartbeat, health]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let x = 0;
    let lastY: number | null = null;
    let phase = 0;
    let last = performance.now();
    let amp = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      x = 0;
      lastY = null;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const drawStatic = () => {
      const { heartbeat: hb, health: h } = stateRef.current;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = HEALTH_META[h].stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const a = (hb / 100) * height * 0.38;
      for (let i = 0; i <= width; i++) {
        const t = ((i / width) * 3) % 1;
        const y = height * 0.58 - (hb > 0 ? pqrst(t) * a : 0);
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      }
      ctx.stroke();
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { heartbeat: hb, health: h } = stateRef.current;
      const targetAmp = hb / 100;
      amp += (targetAmp - amp) * Math.min(1, dt * 2.5);
      const bpm = hb <= 0 ? 0 : 48 + hb * 0.42;
      const speed = Math.max(90, width / 4.5); // px per second
      const color = HEALTH_META[h].stroke;

      const steps = Math.max(1, Math.round(speed * dt));
      for (let s = 0; s < steps; s++) {
        phase = bpm > 0 ? (phase + bpm / 60 / speed) % 1 : 0;
        // erase a band ahead of the pen (sweep effect)
        ctx.clearRect(x + 1, 0, 14, height);
        const base = height * 0.58;
        const jitter = hb <= 0 ? noise(now / 900 + x) * 0.6 : noise(now / 500 + x) * 0.4;
        const y = base - (bpm > 0 ? pqrst(phase) * amp * height * 0.4 : 0) + jitter;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(x, lastY ?? y);
        ctx.lineTo(x + 1, y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        lastY = y;
        x += 1;
        if (x >= width) {
          x = 0;
          lastY = null;
        }
      }
      // pen head
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, lastY ?? height * 0.58, 2.2, 0, Math.PI * 2);
      ctx.fill();
      raf = requestAnimationFrame(frame);
    };

    if (reduced) {
      drawStatic();
      const id = window.setInterval(drawStatic, 1000);
      return () => {
        window.clearInterval(id);
        ro.disconnect();
      };
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const bpm = heartbeat <= 0 ? 0 : Math.round(48 + heartbeat * 0.42);
  const meta = HEALTH_META[health];
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-white/[0.06] bg-crypt-950 ${className}`}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.25]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(74,222,128,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(74,222,128,0.10) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />
      <canvas
        ref={canvasRef}
        className="relative block h-full w-full"
        role="img"
        aria-label={`Heartbeat monitor: ${bpm === 0 ? 'flatline' : `${bpm} beats per minute`}`}
      />
      <div className="pointer-events-none absolute right-3 top-2 text-right font-mono">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">HR</div>
        <div
          className={`text-2xl font-semibold tabular-nums ${meta.text}`}
          style={{ textShadow: `0 0 12px ${meta.stroke}` }}
        >
          {bpm === 0 ? '--' : bpm}
        </div>
      </div>
      <div className="pointer-events-none absolute left-3 top-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        Vitals · {heartbeat}% · <span className={meta.text}>{bpm === 0 ? 'Flatline' : meta.label}</span>
      </div>
    </div>
  );
}
