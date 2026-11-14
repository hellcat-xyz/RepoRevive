/** Server-rendered hero copy. Entrance uses CSS so the text is visible even before JS hydrates. */
export function HeroTitle() {
  return (
    <>
      <p className="mx-auto inline-flex animate-rise items-center gap-2 rounded-full border border-spirit-400/20 bg-spirit-500/5 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-spirit-300">
        <span className="h-1.5 w-1.5 animate-flicker rounded-full bg-spirit-300" />
        Node.js · npm · GitHub Actions
      </p>
      <h1
        className="mt-6 animate-rise font-display text-5xl font-bold leading-[1.02] tracking-tight text-zinc-50 sm:text-7xl"
        style={{ animationDelay: '0.1s' }}
      >
        Bring dead code
        <br />
        <span className="text-glow text-ecto-400">back to life.</span>
      </h1>
      <p
        className="mx-auto mt-6 max-w-xl animate-rise text-base leading-relaxed text-zinc-400 sm:text-lg"
        style={{ animationDelay: '0.3s' }}
      >
        Paste an abandoned GitHub repository. RepoRevive diagnoses why it no longer installs, builds, or
        tests, repairs it inside a sandbox, and keeps only the fixes it can verify.
      </p>
    </>
  );
}
