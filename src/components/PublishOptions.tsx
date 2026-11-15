'use client';

import { useId } from 'react';
import { PUBLISH_MODES, type PublishModeId } from '@/lib/ecosystems';
import type { GithubStatus } from './useGithub';

export interface PublishChoice {
  mode: PublishModeId;
  allowFork: boolean;
  allowPartial: boolean;
}

interface Props {
  value: PublishChoice;
  onChange: (v: PublishChoice) => void;
  github: GithubStatus;
  onDisconnect: () => void;
}

/** What happens after a repair: patch only (default), review then PR, or automatic draft PR. */
export function PublishOptions({ value, onChange, github, onDisconnect }: Props) {
  const name = useId();
  const needs = PUBLISH_MODES.find((m) => m.id === value.mode)!.needsGithub;
  const unavailable = !github.loading && !github.configured;

  return (
    <fieldset className="mt-5 rounded-2xl border border-white/10 bg-crypt-900/60 p-4">
      <legend className="px-2 font-display text-sm font-semibold text-zinc-200">After the repair</legend>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Publishing mode">
        {PUBLISH_MODES.map((m) => {
          const disabled = m.needsGithub && unavailable;
          const checked = value.mode === m.id;
          return (
            <label
              key={m.id}
              className={`relative flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-spirit-400 ${
                checked ? 'border-ecto-400/60 bg-ecto-400/[0.06]' : 'border-white/10 hover:border-white/20'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                name={name}
                value={m.id}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange({ ...value, mode: m.id })}
                className="sr-only"
              />
              <span className="font-display text-sm font-semibold text-zinc-100">{m.title}</span>
              <span className="text-xs leading-relaxed text-zinc-400">{m.blurb}</span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 text-xs leading-relaxed text-zinc-400" aria-live="polite">
        {unavailable ? (
          <p>
            Pull request publishing is not configured on this server, so only patch download is available.
          </p>
        ) : !needs ? (
          <p>
            Pull requests need your GitHub authorization. You can connect later; patch download always works.
          </p>
        ) : github.connected ? (
          <p className="flex flex-wrap items-center gap-2">
            <span>
              Connected as <span className="font-mono text-ecto-300">{github.user?.login}</span>. RepoRevive
              only ever opens <strong className="font-semibold text-zinc-200">draft</strong> pull requests; it
              never merges or approves.
            </span>
            <button
              type="button"
              onClick={onDisconnect}
              className="rounded-md border border-white/10 px-2 py-0.5 text-zinc-300 hover:border-rose-400/40 hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
            >
              Disconnect
            </button>
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-3">
            <span>Creating a pull request requires authorizing the RepoRevive GitHub App.</span>
            <a
              href="/api/github/connect?returnTo=/"
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 font-medium text-zinc-100 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-spirit-400"
            >
              Connect GitHub
            </a>
          </p>
        )}
      </div>

      {needs && github.connected && (
        <div className="mt-3 grid gap-2 text-sm text-zinc-300 sm:grid-cols-2">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={value.allowFork}
              onChange={(e) => onChange({ ...value, allowFork: e.target.checked })}
              className="mt-1 accent-[#4ade80]"
            />
            <span>
              Allow creating a fork if I cannot push to the repository
              <span className="block text-xs text-zinc-500">
                Without this, repositories you cannot write to are not published.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={value.allowPartial}
              onChange={(e) => onChange({ ...value, allowPartial: e.target.checked })}
              className="mt-1 accent-[#4ade80]"
            />
            <span>
              Also publish a partial repair
              <span className="block text-xs text-zinc-500">
                Off by default: only fully verified repairs are published.
              </span>
            </span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
