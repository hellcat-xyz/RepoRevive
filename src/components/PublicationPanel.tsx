'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublicationDto } from '@/server/publications';

const FLOW = [
  'QUEUED',
  'AUTHORIZING',
  'PREPARING_BRANCH',
  'PUBLISHING_COMMIT',
  'CREATING_PR',
  'CREATED',
] as const;
const FLOW_LABEL: Record<string, string> = {
  QUEUED: 'Queued',
  AUTHORIZING: 'Checking access',
  PREPARING_BRANCH: 'Preparing branch',
  PUBLISHING_COMMIT: 'Publishing commit',
  CREATING_PR: 'Opening draft PR',
  CREATED: 'Created',
};
const ACTIVE = new Set(['QUEUED', 'AUTHORIZING', 'PREPARING_BRANCH', 'PUBLISHING_COMMIT', 'CREATING_PR']);

interface Props {
  jobId: string;
  tick: number;
  /** Job finished; publication rows exist only after that. */
  finished: boolean;
  hasChanges: boolean;
}

/** Publication state, approval, retry, and the link to the real pull request. All actions call the server, which re-checks ownership. */
export function PublicationPanel({ jobId, tick, finished, hasChanges }: Props) {
  const [data, setData] = useState<{ mode: string; publication: PublicationDto | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowFork, setAllowFork] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/resurrections/${jobId}/publication`, { cache: 'no-store' });
    if (res.ok) setData((await res.json()) as { mode: string; publication: PublicationDto | null });
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load, tick, finished]);

  const status = data?.publication?.status;
  useEffect(() => {
    if (!finished || (status && !ACTIVE.has(status) && status !== 'PENDING_APPROVAL')) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [finished, status, load]);

  async function act(action: 'approve' | 'retry' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resurrections/${jobId}/publication`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, allowFork }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(b.error?.message ?? `Request failed (${res.status})`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data || data.mode === 'PATCH_ONLY') return null;
  const p = data.publication;

  return (
    <section className="panel mt-6 p-4 sm:p-5" aria-labelledby="pr-title" data-testid="publication-panel">
      <h2 id="pr-title" className="font-display text-base font-semibold text-zinc-100">
        GitHub pull request
      </h2>

      {!p && (
        <p className="mt-2 text-sm text-zinc-400" aria-live="polite">
          {finished
            ? hasChanges
              ? 'Preparing publication…'
              : 'There are no verified changes to publish.'
            : 'A draft pull request will be prepared when the repair finishes and passes verification.'}
        </p>
      )}

      {p && (
        <div className="mt-3 space-y-3 text-sm" aria-live="polite">
          {ACTIVE.has(p.status) || p.status === 'CREATED' ? (
            <ol className="flex flex-wrap gap-2" aria-label="Publication progress">
              {FLOW.map((s, i) => {
                const idx = FLOW.indexOf(p.status as (typeof FLOW)[number]);
                const state = i < idx || p.status === 'CREATED' ? 'done' : i === idx ? 'now' : 'todo';
                return (
                  <li
                    key={s}
                    aria-current={state === 'now' ? 'step' : undefined}
                    className={`rounded-full px-2.5 py-1 text-xs ring-1 ${state === 'done' ? 'text-ecto-300 ring-ecto-400/30' : state === 'now' ? 'animate-pulse text-spirit-300 ring-spirit-400/40' : 'text-zinc-600 ring-white/10'}`}
                  >
                    {FLOW_LABEL[s]}
                  </li>
                );
              })}
            </ol>
          ) : null}

          {p.status === 'PENDING_APPROVAL' && (
            <div className="space-y-3">
              <p className="text-zinc-300">
                The verified diff is ready ({p.files.length} file{p.files.length === 1 ? '' : 's'}:{' '}
                <span className="font-mono text-xs">{p.files.join(', ')}</span>). Review it above, then
                approve to open a <strong>draft</strong> pull request on{' '}
                <span className="font-mono">{p.target}</span> (base{' '}
                <span className="font-mono">{p.baseBranch}</span>).
              </p>
              <label className="flex items-start gap-2 text-zinc-300">
                <input
                  type="checkbox"
                  checked={allowFork}
                  onChange={(e) => setAllowFork(e.target.checked)}
                  className="mt-1 accent-[#4ade80]"
                />
                <span>
                  If I cannot push to this repository, create a fork and open the pull request from it.
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act('approve')}
                  className="rounded-xl bg-ecto-400 px-4 py-2 font-display font-semibold text-crypt-950 hover:bg-ecto-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400 disabled:opacity-60"
                >
                  {busy ? 'Working…' : 'Approve and create draft PR'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act('cancel')}
                  className="rounded-xl border border-white/10 px-4 py-2 text-zinc-300 hover:border-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
                >
                  Do not publish
                </button>
              </div>
            </div>
          )}

          {p.status === 'CREATED' && p.prUrl && (
            <div className="space-y-2">
              <a
                href={p.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-ecto-400 px-5 py-2.5 font-display font-semibold text-crypt-950 shadow-[0_0_30px_-5px_rgba(74,222,128,0.6)] hover:bg-ecto-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
              >
                View Pull Request #{p.prNumber}
                <span aria-hidden="true">↗</span>
              </a>
              <dl className="grid gap-x-6 gap-y-1 text-xs text-zinc-400 sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-zinc-500">Status</dt>
                  <dd>{p.isDraft ? 'Draft' : 'Open'} · created</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-zinc-500">Branch</dt>
                  <dd className="break-all font-mono">
                    {p.head ?? p.target}:{p.headBranch}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-zinc-500">Into</dt>
                  <dd className="font-mono">
                    {p.target}:{p.baseBranch}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-zinc-500">
                Verification ran in RepoRevive's sandbox. It is not a GitHub Actions result; check your CI on
                the pull request.
              </p>
            </div>
          )}

          {(p.status === 'FAILED' || p.status === 'BLOCKED' || p.status === 'AUTH_EXPIRED') && (
            <div
              className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-rose-200"
              role="alert"
            >
              <p className="font-medium">
                {p.status === 'AUTH_EXPIRED'
                  ? 'GitHub authorization expired'
                  : p.status === 'BLOCKED'
                    ? 'No pull request was created'
                    : 'Publishing failed'}
              </p>
              <p className="mt-1 text-sm">
                {p.lastError ?? 'Unknown error.'}{' '}
                {p.lastErrorCode && <span className="font-mono text-xs opacity-70">({p.lastErrorCode})</span>}
              </p>
              <p className="mt-2 text-xs text-rose-200/70">
                Your verified patch and report are still available to download.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {p.status === 'AUTH_EXPIRED' && (
                  <a
                    href={`/api/github/connect?returnTo=${encodeURIComponent(`/r/${jobId}`)}`}
                    className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-zinc-100 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
                  >
                    Reconnect GitHub
                  </a>
                )}
                {p.retryable && p.lastErrorCode !== 'POLICY' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act('retry')}
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-100 hover:border-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
                  >
                    {busy ? 'Working…' : `Retry (${p.attempts}/${p.maxAttempts})`}
                  </button>
                )}
              </div>
            </div>
          )}

          {p.status === 'CANCELLED' && (
            <p className="text-zinc-400">Publishing was cancelled. The patch can still be downloaded.</p>
          )}
          {p.excluded.length > 0 && (
            <p className="text-xs text-amber-200/80">
              Not included in the pull request: {p.excluded.map((e) => e.path).join(', ')} (apply the patch
              manually after review).
            </p>
          )}
          {error && (
            <p className="text-sm text-rose-300" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
