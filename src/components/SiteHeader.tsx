import Link from 'next/link';
import { LogoMark } from './Logo';

export function SiteHeader() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40">
      <div className="pointer-events-auto mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5 rounded-lg" aria-label="RepoRevive home">
          <LogoMark className="h-8 w-8 transition-transform duration-300 group-hover:-translate-y-0.5" />
          <span className="font-display text-lg font-semibold tracking-tight text-zinc-100">
            Repo<span className="text-ecto-400">Revive</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-500 sm:flex">
          <span className="rounded-full border border-white/5 bg-crypt-900/70 px-3 py-1.5 backdrop-blur">
            Sandboxed
          </span>
          <span className="rounded-full border border-white/5 bg-crypt-900/70 px-3 py-1.5 backdrop-blur">
            Verified fixes
          </span>
          <span className="rounded-full border border-white/5 bg-crypt-900/70 px-3 py-1.5 backdrop-blur">
            Never pushes
          </span>
        </nav>
      </div>
    </header>
  );
}
