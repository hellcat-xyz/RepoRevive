---
inclusion: fileMatch
fileMatchPattern: '{src/app/**,src/components/**}'
---

# UI Consistency Rules: "Haunted Developer Graveyard"

## Palette (Tailwind theme tokens in `src/app/globals.css`)

- Backgrounds: `crypt-950` (#07080a) to `crypt-800` (#14171c) charcoal.
- Primary accent: `ecto-400` (#4ade80-ish eerie green) for life, success, and primary actions.
- Secondary accent: `spirit-400` (purple) for AI/analysis and focus rings.
- Status colours: Dead = zinc, Diagnosing = spirit, Repairing = amber, Partially Revived = lime,
  Revived = ecto, Unrecoverable = rose.
- Body text `zinc-200` on dark; secondary `zinc-400`. Maintain WCAG AA contrast.

## Typography

- Display headings: `font-display` (Space Grotesk) with tight tracking. No novelty horror fonts.
- Body: `font-sans` (Inter). Code, logs, and metrics: `font-mono` (JetBrains Mono).

## Motion

- Framer Motion for enter/exit and state transitions; CSS for ambient loops (fog, glow).
- Ambient animations must be subtle and respect `prefers-reduced-motion` (disable fog drift,
  ECG sweep falls back to static trace).
- Durations: micro 150-250ms, transitions 300-500ms, celebratory resurrection up to 1.2s.

## Components

- Reuse `HealthBadge`, `EcgMonitor`, `Terminal`, `Panel`, and `Button`; do not restyle ad hoc.
- Every interactive element has visible focus styles and an accessible name.
- Layout must work from 360px wide to desktop.
