import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 pt-48 text-center">
      <p className="font-mono text-sm text-zinc-600">404</p>
      <h1 className="mt-2 font-display text-3xl font-semibold text-zinc-100">Nothing is buried here.</h1>
      <Link href="/" className="mt-6 inline-block text-ecto-300 hover:underline">
        ← Back to the graveyard
      </Link>
    </div>
  );
}
