export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="rr-stone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a404c" />
          <stop offset="1" stopColor="#1c2028" />
        </linearGradient>
      </defs>
      <path d="M7 29V13a9 9 0 0 1 18 0v16z" fill="url(#rr-stone)" stroke="#4b5260" strokeWidth="1" />
      <path
        d="M3 20h7l2-4 3 8 3-11 2.5 7H29"
        fill="none"
        stroke="#4ade80"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: 'drop-shadow(0 0 3px rgba(74,222,128,.8))' }}
      />
      <rect x="5" y="28.5" width="22" height="1.5" rx=".75" fill="#272c36" />
    </svg>
  );
}
