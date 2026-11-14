'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { parseGitHubUrl } from '@/lib/github';

const EXAMPLES = [
  'https://github.com/request/request',
  'https://github.com/bower/bower',
  'https://github.com/expressjs/express',
];

export function ResurrectForm() {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const parsed = useMemo(() => parseGitHubUrl(url), [url]);
  const clientError = touched && url.trim() && !parsed.ok ? parsed.error : null;
  const error = serverError ?? clientError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (!parsed.ok) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/resurrections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: parsed.repo.url }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!res.ok || !body.id) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      router.push(`/r/${body.id}`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="w-full">
      <label htmlFor={inputId} className="sr-only">
        Public GitHub repository URL
      </label>
      <div
        className={`group relative flex flex-col gap-2 rounded-2xl border bg-crypt-900/80 p-2 shadow-[0_0_0_1px_rgba(0,0,0,0.4),0_30px_80px_-30px_rgba(74,222,128,0.35)] backdrop-blur-md transition-colors sm:flex-row sm:items-center ${
          error ? 'border-rose-500/40' : 'border-white/10 focus-within:border-ecto-400/50'
        }`}
      >
        <div className="pointer-events-none absolute -inset-px -z-10 rounded-2xl bg-gradient-to-r from-ecto-500/0 via-ecto-400/20 to-spirit-500/0 opacity-0 blur-xl transition-opacity duration-500 group-focus-within:opacity-100" />
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3">
          <svg viewBox="0 0 16 16" className="h-5 w-5 shrink-0 fill-zinc-500" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/abandoned-project"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setServerError(null);
            }}
            onBlur={() => setTouched(true)}
            aria-invalid={Boolean(error)}
            aria-describedby={`${inputId}-hint`}
            className="h-12 w-full min-w-0 bg-transparent font-mono text-[15px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
        <motion.button
          type="submit"
          disabled={submitting}
          whileHover={{ scale: submitting ? 1 : 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="relative inline-flex h-12 shrink-0 items-center justify-center gap-2 overflow-hidden rounded-xl bg-ecto-400 px-6 font-display text-[15px] font-semibold text-crypt-950 shadow-[0_0_30px_-5px_rgba(74,222,128,0.7)] transition-colors hover:bg-ecto-300 disabled:cursor-wait disabled:bg-ecto-500/70"
        >
          <AnimatePresence mode="wait" initial={false}>
            {submitting ? (
              <motion.span
                key="busy"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="flex items-center gap-2"
              >
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-crypt-950/30 border-t-crypt-950" />
                Summoning…
              </motion.span>
            ) : (
              <motion.span
                key="idle"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="flex items-center gap-2"
              >
                <svg
                  viewBox="0 0 20 20"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden="true"
                >
                  <path d="M2 11h4l2-5 3 9 2-4h5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Resurrect Repository
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      <div id={`${inputId}-hint`} className="mt-3 min-h-6 px-1 text-sm" aria-live="polite">
        <AnimatePresence mode="wait">
          {error ? (
            <motion.p
              key="err"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-rose-300"
            >
              {error}
            </motion.p>
          ) : parsed.ok ? (
            <motion.p
              key="ok"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="font-mono text-ecto-300/80"
            >
              ✓ {parsed.repo.owner}/{parsed.repo.name}
            </motion.p>
          ) : (
            <motion.p
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-wrap items-center gap-2 text-zinc-500"
            >
              <span>Public Node.js/npm repositories. Try</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setUrl(ex);
                    setTouched(true);
                  }}
                  className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-0.5 font-mono text-xs text-zinc-400 transition-colors hover:border-ecto-400/30 hover:text-ecto-300"
                >
                  {ex.replace('https://github.com/', '')}
                </button>
              ))}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </form>
  );
}
