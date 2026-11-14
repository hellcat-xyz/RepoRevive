# Implementation Plan: RepoRevive MVP

Roadmap order favours a working end-to-end pipeline first, then UI polish.

- [x] 1. Project scaffolding
  - [x] 1.1 Next.js 15 + TypeScript strict + Tailwind v4 + Framer Motion
  - [x] 1.2 Vitest + fast-check config, ESLint flat config, Prettier
  - [x] 1.3 Prisma schema, `.env.example`, docker-compose for PostgreSQL
  - [x] 1.4 Kiro hooks for format, lint, and tests
  - _Requirements: all (foundation)_

- [x] 2. Engine core
  - [x] 2.1 Types, `ResurrectionError`, GitHub URL parser (P7) — _Req 1.1, 1.2_
  - [x] 2.2 Job state machine + health computation (P3, P6) — _Req 6.5, 9.1_
  - [x] 2.3 Safe `Workspace` with apply/rollback (P1) — _Req 5.3, 8.4_
  - [x] 2.4 Git patch generation (P2 + `git apply --check` integration) — _Req 6.2, 6.3_
  - [x] 2.5 Verification acceptance + scoring (P4) — _Req 5.2_

- [x] 3. npm ecosystem
  - [x] 3.1 Analysis (manifest, lockfiles, runtime declarations, scripts, tests, source mix) — _Req 2_
  - [x] 3.2 Runtime selection — _Req 3.1, 9.4_
  - [x] 3.3 Verification plan and step commands — _Req 3.2, 3.3, 3.6_
  - [x] 3.4 Diagnosis rules + fixtures — _Req 3.4, 3.5_
  - [x] 3.5 Era-matched version resolution + npm registry client — _Req 4.1_
  - [x] 3.6 Fix strategies — _Req 4.1, 4.3_

- [x] 4. CI analysis and static fixes — _Req 2.5, 5.4_

- [x] 5. Pipeline orchestration
  - [x] 5.1 Stages, events, repair loop, budgets — _Req 4, 5_
  - [x] 5.2 Report builder (JSON + Markdown) — _Req 6.1, 6.4_
  - [x] 5.3 FakeSandbox world model + end-to-end property test (P5) — _Req 5, 9.5_

- [x] 6. Sandbox
  - [x] 6.1 DockerSandbox with security flags, timeouts, streaming, cleanup — _Req 8_
  - [x] 6.2 Opt-in Docker integration test

- [x] 7. Server
  - [x] 7.1 Config (zod env), Prisma client, job repository, DB event sink — _Req 7.3_
  - [x] 7.2 Worker: claim loop, concurrency, stale job recovery, graceful shutdown — _Req 9.2_
  - [x] 7.3 GitHub metadata check (exists/public/size) — _Req 1.3, 1.4_
  - [x] 7.4 API routes + rate limiting + SSE with resume — _Req 1, 6, 7_

- [x] 8. Optional LLM strategy — _Req 4.6_

- [x] 9. UI
  - [x] 9.1 Design tokens, fonts, layout, fog/tombstone scene — _Req 10.1_
  - [x] 9.2 URL form with validation + submit micro-interactions
  - [x] 9.3 Recent resurrections graveyard
  - [x] 9.4 Job page: ECG monitor, health badge, stage timeline, terminal, attempts — _Req 10.2_
  - [x] 9.5 Final dashboard: issues, dependency changes, verification table, diff viewer, downloads — _Req 10.3_
  - [x] 9.6 Resurrection celebration animation, reduced-motion support — _Req 10.4_

- [x] 10. Documentation: README (architecture, running locally, security model, limitations)

## Status

All MVP tasks are implemented. Verified locally: 104 unit/property/pipeline tests, PostgreSQL integration test, production build, and API/SSE checks. Not yet verified: the real Docker sandbox (`npm run test:docker`) because Docker was not available on the development machine.
