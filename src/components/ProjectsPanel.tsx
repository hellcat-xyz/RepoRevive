'use client';

import { HealthBadge } from './HealthBadge';
import { ECOSYSTEM_LABEL } from '@/lib/ecosystems';
import type { ReportProject } from '@/engine/report';

/** Per-project results for repositories with several projects (MERN client/server, monorepo folders). */
export function ProjectsPanel({ projects }: { projects: ReportProject[] }) {
  if (projects.length < 2 && !projects.some((p) => p.notRun)) return null;
  return (
    <section className="panel mt-6 p-4 sm:p-5" aria-labelledby="projects-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="projects-title" className="font-display text-base font-semibold text-zinc-100">
          Projects
        </h2>
        <span className="font-mono text-xs text-zinc-400">{projects.length}</span>
      </div>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {projects.map((p) => (
          <li
            key={p.folder || '(root)'}
            className="rounded-xl border border-white/[0.06] bg-crypt-900/60 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-zinc-100">{p.folder || '(root)'}</span>
              <HealthBadge health={p.health} size="sm" />
            </div>
            <p className="mt-1 font-mono text-[11px] text-zinc-400">
              {ECOSYSTEM_LABEL[p.ecosystem] ?? p.ecosystem}
              {p.packageManager ? ` · ${p.packageManager}` : ''}
              {(p.runtime.final ?? p.runtime.baseline) ? ` · ${p.runtime.final ?? p.runtime.baseline}` : ''}
            </p>
            {p.notRun && <p className="mt-2 text-sm text-amber-300">{p.notRun}</p>}
            {p.error && (
              <p className="mt-2 text-sm text-rose-300">
                <span className="font-mono text-xs">{p.error.code}</span> · {p.error.message}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
