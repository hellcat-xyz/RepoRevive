# RepoRevive V2 — Tasks

Legend: `[x]` implemented and covered by automated tests that ran green in the authoring environment (no Docker daemon,
no PostgreSQL, no GitHub App). `[~]` implemented, but the part that needs Docker / PostgreSQL / a real GitHub App was
not executed (opt-in tests exist). `[ ]` not done.

## Phase 1: Specs

- [x] 1.1 Inspect codebase, record limitations (requirements.md)
- [x] 1.2 Specs, steering (`v2-ecosystems-and-publishing.md`, product/security/architecture updates), hook `v2-spec-sync`

## Phase 2: Generic engine

- [x] 2.1 `core/images.ts` allow-list + property tests (`tests/property/images-and-coverage.test.ts`)
- [x] 2.2 `core/command.ts` validated argv and shell-safe values
- [x] 2.3 `RuntimeSelection.family/version`; DockerSandbox uses allow-list, per-family cache env, forbidden env names
- [x] 2.4 Ecosystem `detection()` with confidence, ranked registry with ambiguity, `sandboxEnv`, per-ecosystem registries
- [x] 2.5 `core/coverage.ts` (build-only / full / failing...) in report and markdown
- [x] 2.6 New issue kinds with explanations

## Phase 3: Python

- [x] 3.1 detect/analyze/runtime/plan (pip, Poetry, uv, Pipenv)
- [x] 3.2 diagnosis; 3.3 strategies; 3.4 fixtures + pipeline tests (`tests/pipeline/python.test.ts`)
- [~] 3.5 Real-container run of the generated install scripts (Poetry/uv/Pipenv paths especially)

## Phase 4: Rust

- [x] 4.1-4.4 detect/analyze/runtime/plan/diagnose/strategies/fixtures (`tests/pipeline/rust.test.ts`)
- [~] 4.5 Real-container `cargo` runs

## Phase 5: GitHub authentication

- [x] 5.1 Prisma schema + migration `20261115000000_v2_ecosystems_github` (generated with `prisma migrate diff`)
- [~] 5.1b Migration applied to a real PostgreSQL (CI `database` job does this; not run locally)
- [x] 5.2 AES-256-GCM token storage; 5.3 OAuth state; 5.4 signed sessions; 5.5 routes; 5.6 ownership checks
- [~] 5.7 Full OAuth round trip against github.com

## Phase 6: Publishing

- [x] 6.1 state machine; 6.2 policy; 6.3 changes to tree entries; 6.4 PR body; 6.5 REST client; 6.6 publisher
- [x] 6.7 Prisma store, worker loop, approval/retry/cancel routes, SSE hold-open for automatic PRs
- [x] 6.8 tests incl. properties (`tests/unit/publisher.test.ts`, `github-rest.test.ts`, `authorization.test.ts`)
- [~] 6.9 Live PR creation (`tests/integration/github-live.test.ts`, opt-in, needs a test repo and token)
- [~] 6.10 Fork flow against GitHub (cross-repo commit parents rely on the shared fork object store)

## Phase 7: UI

- [x] 7.1 ecosystem chips, publishing modes, GitHub connect; 7.2 `EcosystemPanel`; 7.3 `PublicationPanel`
- [~] 7.4 Visual/browser verification (build compiles; no browser run was possible)

## Phase 8: Additional ecosystems

- [x] 8.1 Go (`tests/pipeline/go.test.ts`)
- [x] 8.2 Maven (`tests/pipeline/maven.test.ts`)
- [x] 8.3 pnpm / Yarn plan and detection (`tests/property/ecosystem-isolation.test.ts`)
- [ ] 8.4 Gradle adapter (not started; not advertised)
- [ ] 8.5 Per-workspace verification reporting for JS/Rust workspaces

## Phase 9: Hardening

- [x] 9.1 CI workflow; 9.2 README, `.env.example`; 9.3 tests, typecheck, lint, prettier, `next build`
- [ ] 9.4 Run the opt-in Docker and live GitHub tests (needs Docker and a test repository)

## Phase 10: Static sites and multi-project repositories

- [x] 10.1 Multi-project repositories (MERN, monorepo folders): see `.kiro/specs/reporevive-monorepo`
- [x] 10.2 Static site ecosystem: references scan, case-fix strategy, `VERIFIED_STATIC` labelling, tests, README and UI chip