import { GraveyardScene } from '@/components/GraveyardScene';
import { HeroTitle } from '@/components/HeroTitle';
import { RecentGraves } from '@/components/RecentGraves';
import { ResurrectForm } from '@/components/ResurrectForm';

const STEPS = [
  {
    n: '01',
    title: 'Exhume',
    body: 'The repository is shallow-cloned into a locked-down Docker sandbox: no capabilities, read-only root, resource limits.',
  },
  {
    n: '02',
    title: 'Autopsy',
    body: 'Install, build, and test run untouched to record a baseline. Failures are classified: peer conflicts, dead git:// URLs, node-gyp, OpenSSL 3, missing modules…',
  },
  {
    n: '03',
    title: 'Revive',
    body: 'One targeted fix at a time, least invasive first, with era-matched versions. Each fix is re-verified and rolled back if it does not help.',
  },
  {
    n: '04',
    title: 'Hand over',
    body: 'A report separating verified fixes from suggestions, plus a git-compatible .patch. Nothing is ever pushed to GitHub.',
  },
];

export default function HomePage() {
  return (
    <>
      <section className="relative flex min-h-[100svh] items-center overflow-hidden">
        <GraveyardScene />
        <div className="relative mx-auto w-full max-w-3xl px-4 pb-40 pt-28 text-center sm:px-6">
          <HeroTitle />
          <div className="mt-10">
            <ResurrectForm />
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="how">
        <p className="eyebrow text-center">The ritual</p>
        <h2
          id="how"
          className="mt-2 text-center font-display text-3xl font-semibold tracking-tight text-zinc-100"
        >
          How a resurrection works
        </h2>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="panel group p-5 transition-colors hover:border-ecto-400/20">
              <span className="font-mono text-xs text-ecto-400/80">{s.n}</span>
              <h3 className="mt-2 font-display text-lg font-semibold text-zinc-100">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="relative mx-auto max-w-6xl px-4 pb-28 sm:px-6" aria-labelledby="recent">
        <p className="eyebrow text-center">The graveyard</p>
        <h2
          id="recent"
          className="mb-10 mt-2 text-center font-display text-3xl font-semibold tracking-tight text-zinc-100"
        >
          Recently disturbed graves
        </h2>
        <RecentGraves />
      </section>

      <footer className="border-t border-white/[0.05] py-8 text-center font-mono text-xs text-zinc-600">
        RepoRevive · untrusted code runs only in sandboxes · patches are yours to apply
      </footer>
    </>
  );
}
