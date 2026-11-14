'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptRecord, Health, JobStatus, StageName } from '@/engine/core/types';
import { isFinished } from '@/lib/health';
import type { ClientEvent, JobSnapshot } from '@/lib/types';
import type { TerminalLine } from './Terminal';

export interface ResurrectionState {
  snapshot: JobSnapshot | null;
  lines: TerminalLine[];
  attempts: AttemptRecord[];
  status: JobStatus | null;
  health: Health;
  heartbeat: number;
  stage: StageName | null;
  live: boolean;
  finished: boolean;
  /** True only when the job finished while this page was open (drives the celebration). */
  finishedLive: boolean;
  error: string | null;
}

const MAX_LINES = 8000;

export function useResurrection(id: string) {
  const [state, setState] = useState<ResurrectionState>({
    snapshot: null,
    lines: [],
    attempts: [],
    status: null,
    health: 'DEAD',
    heartbeat: 0,
    stage: null,
    live: false,
    finished: false,
    finishedLive: false,
    error: null,
  });
  const pending = useRef<TerminalLine[]>([]);
  const seen = useRef(new Set<number>());
  const initiallyFinished = useRef<boolean | null>(null);

  const loadSnapshot = useCallback(async () => {
    const res = await fetch(`/api/resurrections/${id}`, { cache: 'no-store' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Failed to load (${res.status})`);
    }
    const snap = (await res.json()) as JobSnapshot;
    if (initiallyFinished.current === null) initiallyFinished.current = isFinished(snap.status);
    setState((s) => ({
      ...s,
      snapshot: snap,
      status: snap.status,
      health: snap.health,
      heartbeat: snap.heartbeat,
      stage: snap.currentStage ?? s.stage,
      attempts: snap.attempts.length >= s.attempts.length ? snap.attempts : s.attempts,
      finished: isFinished(snap.status),
    }));
    return snap;
  }, [id]);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const flush = setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current;
      pending.current = [];
      setState((s) => {
        const lines = s.lines.concat(batch);
        return { ...s, lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines };
      });
    }, 120);

    loadSnapshot()
      .then(() => {
        if (cancelled) return;
        es = new EventSource(`/api/resurrections/${id}/events`);
        setState((s) => ({ ...s, live: !s.finished }));
        es.onmessage = (msg) => {
          let e: ClientEvent;
          try {
            e = JSON.parse(msg.data) as ClientEvent;
          } catch {
            return;
          }
          if (seen.current.has(e.seq)) return;
          seen.current.add(e.seq);
          const d = e.data ?? {};
          switch (e.type) {
            case 'log':
              pending.current.push({
                seq: e.seq,
                level: e.level,
                message: e.message,
                source: d.source as string | undefined,
                ts: e.ts,
              });
              break;
            case 'stage':
              pending.current.push({
                seq: e.seq,
                level: 'info',
                message: `── ${e.message} ──`,
                source: 'stage',
                ts: e.ts,
              });
              setState((s) => ({ ...s, stage: d.stage as StageName }));
              break;
            case 'status':
              setState((s) => ({ ...s, status: d.status as JobStatus, health: d.health as Health }));
              break;
            case 'heartbeat':
              setState((s) => ({ ...s, heartbeat: Number(d.value) || 0 }));
              break;
            case 'attempt': {
              const a = d.attempt as AttemptRecord;
              setState((s) =>
                s.attempts.some((x) => x.seq === a.seq) ? s : { ...s, attempts: [...s.attempts, a] },
              );
              break;
            }
            case 'done':
              setState((s) => ({
                ...s,
                health: d.health as Health,
                finished: true,
                live: false,
                finishedLive: initiallyFinished.current === false,
              }));
              void loadSnapshot().catch(() => undefined);
              break;
          }
        };
        es.addEventListener('end', () => {
          es?.close();
          setState((s) => ({ ...s, live: false }));
          void loadSnapshot().catch(() => undefined);
        });
        es.onerror = () => {
          // EventSource reconnects automatically with Last-Event-ID; nothing to do.
        };
      })
      .catch((err: unknown) =>
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) })),
      );

    return () => {
      cancelled = true;
      clearInterval(flush);
      es?.close();
    };
  }, [id, loadSnapshot]);

  const cancel = useCallback(async () => {
    await fetch(`/api/resurrections/${id}/cancel`, { method: 'POST' });
  }, [id]);

  return { ...state, cancel, reload: loadSnapshot };
}
