import type { AttemptRecord, Health, StageName } from '@/engine/core/types';

export const HEALTH_META: Record<
  Health,
  { label: string; description: string; text: string; bg: string; ring: string; stroke: string }
> = {
  DEAD: {
    label: 'Dead',
    description: 'Awaiting exhumation',
    text: 'text-zinc-300',
    bg: 'bg-zinc-500/10',
    ring: 'ring-zinc-500/30',
    stroke: '#71717a',
  },
  DIAGNOSING: {
    label: 'Diagnosing',
    description: 'Examining the cause of death',
    text: 'text-spirit-300',
    bg: 'bg-spirit-500/10',
    ring: 'ring-spirit-400/40',
    stroke: '#a78bfa',
  },
  REPAIRING: {
    label: 'Repairing',
    description: 'Applying and verifying fixes',
    text: 'text-amber-300',
    bg: 'bg-amber-500/10',
    ring: 'ring-amber-400/40',
    stroke: '#fbbf24',
  },
  PARTIALLY_REVIVED: {
    label: 'Partially Revived',
    description: 'Showing signs of life',
    text: 'text-lime-300',
    bg: 'bg-lime-500/10',
    ring: 'ring-lime-400/40',
    stroke: '#a3e635',
  },
  REVIVED: {
    label: 'Revived',
    description: "It's alive!",
    text: 'text-ecto-300',
    bg: 'bg-ecto-500/10',
    ring: 'ring-ecto-400/50',
    stroke: '#4ade80',
  },
  UNRECOVERABLE: {
    label: 'Unrecoverable',
    description: 'Beyond automatic revival',
    text: 'text-rose-300',
    bg: 'bg-rose-500/10',
    ring: 'ring-rose-400/40',
    stroke: '#fb7185',
  },
};

export const STAGES: { id: StageName; label: string; hint: string }[] = [
  { id: 'clone', label: 'Exhume', hint: 'Clone into sandbox' },
  { id: 'analyze', label: 'Examine', hint: 'Inspect manifest, lockfiles, CI' },
  { id: 'baseline', label: 'Baseline', hint: 'Install, build, test as-is' },
  { id: 'diagnose', label: 'Diagnose', hint: 'Classify failures' },
  { id: 'repair', label: 'Repair', hint: 'Apply & verify fixes' },
  { id: 'finalize', label: 'Verify', hint: 'Clean final verification' },
  { id: 'report', label: 'Report', hint: 'Report & patch' },
];

export const ATTEMPT_META: Record<
  AttemptRecord['status'],
  { label: string; className: string; explain: string }
> = {
  VERIFIED: {
    label: 'Verified',
    className: 'bg-ecto-500/15 text-ecto-300 ring-ecto-400/40',
    explain: 'Kept: sandbox verification showed improvement with no regressions. Included in the patch.',
  },
  VERIFIED_STATIC: {
    label: 'Verified (static)',
    className: 'bg-ecto-500/5 text-ecto-200 ring-ecto-400/30 ring-dashed',
    explain: 'Kept: validated by parsing and rule checks, not by running it. Included in the patch.',
  },
  REVERTED: {
    label: 'Reverted',
    className: 'bg-rose-500/10 text-rose-300 ring-rose-400/30',
    explain: 'Rolled back: verification did not support this change. Not in the patch.',
  },
  SUGGESTED: {
    label: 'Suggestion · unverified',
    className: 'bg-amber-500/10 text-amber-300 ring-amber-400/30',
    explain: 'Not applied. A manual step you can take; it was not verified and is not in the patch.',
  },
  ERROR: {
    label: 'Error',
    className: 'bg-zinc-500/10 text-zinc-300 ring-zinc-400/30',
    explain: 'The strategy failed before a fix could be produced.',
  },
};

export function isFinished(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}
