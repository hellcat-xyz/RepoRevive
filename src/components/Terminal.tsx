'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface TerminalLine {
  seq: number;
  level: string;
  message: string;
  source?: string;
  ts: string;
}

const LEVEL_CLASS: Record<string, string> = {
  debug: 'text-zinc-500',
  info: 'text-zinc-300',
  warn: 'text-amber-300',
  error: 'text-rose-300',
  success: 'text-ecto-300',
};

const SOURCE_CLASS: Record<string, string> = {
  install: 'text-sky-400/80',
  build: 'text-violet-400/80',
  test: 'text-fuchsia-400/80',
  repair: 'text-ecto-400/80',
  patch: 'text-lime-400/80',
  verify: 'text-cyan-400/80',
  analyze: 'text-indigo-300/80',
  baseline: 'text-sky-300/80',
  report: 'text-spirit-300/80',
  upstream: 'text-orange-300/80',
  strategy: 'text-spirit-300/80',
  diagnose: 'text-amber-400/80',
  clone: 'text-teal-400/80',
};

const MAX_RENDERED = 1500;

export function Terminal({ lines, live }: { lines: TerminalLine[]; live: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [verbose, setVerbose] = useState(true);

  const visible = useMemo(() => {
    const filtered = verbose ? lines : lines.filter((l) => l.level !== 'debug');
    return filtered.slice(-MAX_RENDERED);
  }, [lines, verbose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="panel flex h-full min-h-[320px] flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-ecto-400/70" />
          </div>
          <span className="font-mono text-xs text-zinc-500">sandbox://autopsy.log</span>
          {live && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ecto-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ecto-400" /> live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setVerbose((v) => !v)}
            aria-pressed={verbose}
            className="rounded-md px-2 py-1 font-mono text-[11px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
          >
            {verbose ? 'verbose: on' : 'verbose: off'}
          </button>
          {!follow && (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="rounded-md bg-ecto-400/10 px-2 py-1 font-mono text-[11px] text-ecto-300 hover:bg-ecto-400/20"
            >
              ↓ follow
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        role="log"
        aria-live="off"
        aria-label="Execution log"
        className="flex-1 overflow-y-auto overflow-x-hidden bg-crypt-950/60 px-4 py-3 font-mono text-[12.5px] leading-[1.6]"
      >
        {visible.length === 0 && <p className="text-zinc-600">Waiting for the sandbox to wake up…</p>}
        {lines.length > visible.length && verbose && (
          <p className="mb-2 text-zinc-600">
            … {lines.length - visible.length} earlier lines hidden (download the report for full context)
          </p>
        )}
        {visible.map((l) => (
          <div
            key={l.seq}
            className={`flex gap-3 whitespace-pre-wrap break-words ${LEVEL_CLASS[l.level] ?? 'text-zinc-300'}`}
          >
            <span
              className={`w-16 shrink-0 select-none text-right text-[11px] leading-[1.9] ${SOURCE_CLASS[l.source ?? ''] ?? 'text-zinc-600'}`}
            >
              {l.source ?? 'engine'}
            </span>
            <span className="min-w-0 flex-1">{l.message}</span>
          </div>
        ))}
        {live && (
          <span
            className="inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-ecto-400/80"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
