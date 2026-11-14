/**
 * Decorative background: moonlit sky, dead trees, tombstones, drifting fog and fireflies.
 * Pure SVG/CSS so it renders on the server; ambient motion is disabled by prefers-reduced-motion.
 */

const FIREFLIES = [
  { left: '8%', top: '62%', delay: '0s', size: 3 },
  { left: '17%', top: '48%', delay: '1.8s', size: 2 },
  { left: '29%', top: '70%', delay: '3.1s', size: 3 },
  { left: '41%', top: '58%', delay: '0.9s', size: 2 },
  { left: '57%', top: '66%', delay: '2.4s', size: 3 },
  { left: '66%', top: '52%', delay: '4.2s', size: 2 },
  { left: '78%', top: '64%', delay: '1.2s', size: 3 },
  { left: '88%', top: '55%', delay: '3.6s', size: 2 },
  { left: '94%', top: '72%', delay: '0.4s', size: 2 },
];

function Tombstone({
  x,
  h,
  w,
  tilt,
  label,
}: {
  x: number;
  h: number;
  w: number;
  tilt: number;
  label?: string;
}) {
  const y = 300 - h;
  return (
    <g transform={`rotate(${tilt} ${x + w / 2} 300)`}>
      <path
        d={`M${x} 300 V${y + w / 2} a${w / 2} ${w / 2} 0 0 1 ${w} 0 V300 Z`}
        fill="url(#stone)"
        stroke="rgba(255,255,255,0.06)"
      />
      {label ? (
        <text
          x={x + w / 2}
          y={y + w / 2 + 14}
          textAnchor="middle"
          fontSize="9"
          fill="rgba(255,255,255,0.18)"
          fontFamily="monospace"
        >
          {label}
        </text>
      ) : (
        <path
          d={`M${x + w / 2 - 6} ${y + w / 2 + 6} h12 M${x + w / 2} ${y + w / 2} v16`}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="2"
        />
      )}
    </g>
  );
}

export function GraveyardScene({ intensity = 1 }: { intensity?: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* sky */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(124,58,237,0.18),transparent_60%),radial-gradient(ellipse_60%_40%_at_80%_10%,rgba(74,222,128,0.06),transparent_70%)]" />
      {/* moon */}
      <div className="absolute right-[12%] top-[12%] h-24 w-24 rounded-full bg-[radial-gradient(circle_at_35%_35%,#f4f4f5,#a1a1aa_55%,#52525b)] opacity-80 shadow-[0_0_80px_20px_rgba(196,181,253,0.18)] sm:h-32 sm:w-32" />
      <div className="absolute right-[12%] top-[12%] h-24 w-24 animate-glow rounded-full bg-spirit-400/20 sm:h-32 sm:w-32" />

      {/* skyline */}
      <svg
        className="absolute inset-x-0 bottom-0 h-[46vh] min-h-[280px] w-full"
        viewBox="0 0 1200 300"
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
          <linearGradient id="stone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2a2f39" />
            <stop offset="1" stopColor="#0f1115" />
          </linearGradient>
          <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0d0f13" />
            <stop offset="1" stopColor="#07080a" />
          </linearGradient>
        </defs>
        {/* dead trees */}
        <g stroke="#14171c" strokeWidth="5" fill="none" strokeLinecap="round">
          <path d="M90 300 V160 M90 200 L50 150 M90 185 L130 135 M130 135 L150 120 M50 150 L35 140 M90 160 L80 120" />
          <path d="M1110 300 V150 M1110 190 L1150 140 M1110 175 L1070 120 M1070 120 L1050 110 M1150 140 L1165 128" />
        </g>
        {/* far row */}
        <g opacity="0.55">
          <Tombstone x={210} w={34} h={62} tilt={-3} />
          <Tombstone x={330} w={28} h={50} tilt={4} />
          <Tombstone x={760} w={30} h={56} tilt={-5} />
          <Tombstone x={900} w={36} h={64} tilt={2} />
          <Tombstone x={1010} w={26} h={44} tilt={-2} />
        </g>
        <path d="M0 262 Q 300 240 600 258 T 1200 250 V300 H0 Z" fill="url(#ground)" />
        {/* near row */}
        <Tombstone x={150} w={50} h={92} tilt={-4} label="v0.0.1" />
        <Tombstone x={420} w={44} h={78} tilt={3} label="npm ERR!" />
        <Tombstone x={640} w={52} h={96} tilt={-2} label="EOL" />
        <Tombstone x={840} w={46} h={84} tilt={5} label="404" />
        <path d="M0 285 Q 400 270 800 288 T 1200 280 V300 H0 Z" fill="#07080a" />
      </svg>

      {/* fog */}
      <div className="absolute inset-x-0 bottom-0 h-[38vh]" style={{ opacity: 0.55 * intensity }}>
        <div className="absolute bottom-0 h-full w-[200%] animate-fog-drift bg-[radial-gradient(ellipse_30%_60%_at_20%_80%,rgba(200,210,230,0.10),transparent_70%),radial-gradient(ellipse_25%_50%_at_60%_90%,rgba(200,210,230,0.08),transparent_70%),radial-gradient(ellipse_30%_55%_at_90%_85%,rgba(196,181,253,0.07),transparent_70%)]" />
        <div className="absolute bottom-0 h-3/4 w-[200%] animate-fog-drift-slow bg-[radial-gradient(ellipse_35%_60%_at_30%_100%,rgba(200,210,230,0.09),transparent_70%),radial-gradient(ellipse_30%_60%_at_75%_100%,rgba(74,222,128,0.05),transparent_70%)]" />
      </div>

      {/* fireflies */}
      {FIREFLIES.map((f, i) => (
        <span
          key={i}
          className="absolute animate-float rounded-full bg-ecto-300 shadow-[0_0_10px_3px_rgba(74,222,128,0.6)]"
          style={{ left: f.left, top: f.top, width: f.size, height: f.size, animationDelay: f.delay }}
        />
      ))}

      <div className="grain absolute inset-0 opacity-[0.035] mix-blend-overlay" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(7,8,10,0.85)_100%)]" />
    </div>
  );
}
