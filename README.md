# RepoRevive

Bring dead GitHub repositories back to life. Paste a public Node.js/npm repository URL; RepoRevive clones it
into a locked-down Docker sandbox, records why it fails today, applies targeted fixes one at a time, keeps only
the fixes that verification supports, and gives you a report plus a `git apply`-compatible patch.

Nothing is ever pushed to GitHub. There is no push code path.

## Running locally

Requirements: Node.js 20.9+, Docker (daemon running), PostgreSQL 14+.

```bash
npm install
cp .env.example .env            # adjust DATABASE_URL if needed
docker compose up -d db         # or use any PostgreSQL
npm run db:deploy               # apply migrations
npm run build && npm start      # web UI on http://localhost:3000   (or: npm run dev)
npm run worker                  # in a second terminal: the sandbox worker (needs Docker)
```

The first resurrection pulls `node:<major>` images, which takes a few minutes once.

No Docker for PostgreSQL? `npx prisma dev` starts a local PGlite-backed Postgres. Use its TCP URL with
`&connection_limit=1&pgbouncer=true` appended.

## How a resurrection works

| Stage    | What happens                                                       | Observable outcome            |
| -------- | ------------------------------------------------------------------ | ----------------------------- |
| Exhume   | `git clone --depth 1` inside a container                           | commit SHA and date           |
| Examine  | manifest, lockfiles, Node declarations, scripts, tests, workflows  | analysis + warnings           |
| Baseline | install → build → test on the untouched code                       | baseline results, heartbeat   |
| Diagnose | logs classified into issues with stable fingerprints               | issue list                    |
| Repair   | one fix at a time, least invasive first; verify; keep or roll back | attempts: verified / reverted |
| Verify   | CI modernization (static), then a clean reinstall and final run    | final results                 |
| Report   | report (JSON/Markdown) and patch of accepted fixes only            | downloads                     |

Fix acceptance (`src/engine/core/verification.ts`): a fix is kept only if no previously passing step
regresses **and** either a failing step now passes or the targeted issue disappears without the failure
moving to an earlier step. Rejected fixes are rolled back byte-for-byte.

### Built-in diagnosis and strategies

| Problem                                   | Fix (in order tried)                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ERESOLVE peer conflicts (npm 7+)          | `.npmrc` `legacy-peer-deps=true`                                                                                                     |
| `git://` / SSH git dependencies           | rewrite to `git+https://`                                                                                                            |
| node-sass / node-gyp build failures       | pin era-appropriate Node via `.nvmrc` → replace `node-sass` with `sass`                                                              |
| OpenSSL 3 `ERR_OSSL_EVP_UNSUPPORTED`      | pin Node 16                                                                                                                          |
| `EBADENGINE`, modern syntax on old Node   | pin the required Node                                                                                                                |
| lockfile out of sync, stale pins          | regenerate with `npm install --package-lock-only --ignore-scripts`                                                                   |
| `ETARGET` missing versions                | point at an era-matched published version                                                                                            |
| undeclared modules / missing CLI binaries | add the dependency with an era-matched version                                                                                       |
| broken `@types/*` from floating ranges    | pin to the era-matched version                                                                                                       |
| outdated GitHub Actions                   | action `@v4`, current runners, verified Node version (static check)                                                                  |
| script downloads a file that now 404s     | pin `raw.githubusercontent.com` refs to the upstream commit current at the repo's last commit, only if the missing files exist there |
| failing lifecycle script, TS errors, etc. | diagnosed with command, file, and evidence; AI strategy if configured                                                                |
| unpublished packages, timeouts, network   | suggestion only (never auto-applied)                                                                                                 |
| anything else                             | optional AI strategy (set `LLM_API_KEY`), verified like every other fix                                                              |

"Era-matched" means the newest version published before the repository's last commit, so fixes match the
code's age instead of jumping to `latest`.

Every issue carries a structured diagnosis (category, command, file, lifecycle hook, HTTP status). When no
strategy can safely fix an issue, the repair stage says which strategies were consulted and records a
`SUGGESTED` (unverified) attempt instead of finishing silently. The upstream lookups use read-only GETs to
`api.github.com` from the worker; `GITHUB_TOKEN` (optional) raises the rate limit.

## Security model

- Every clone/install/build/test runs in a fresh container: `--cap-drop ALL`, `no-new-privileges`, read-only
  root filesystem, non-root user, memory/CPU/PID limits, tmpfs `/tmp`, and a timeout that kills the container.
- Network is enabled only for clone and dependency install. Build and test run with `--network none`
  (override with `SANDBOX_NETWORK_FOR_BUILD=true`).
- The host never executes repository code and never runs `git` against the clone. Patches are generated in
  TypeScript. Host file access rejects symlinks, absolute paths, and traversal.
- Secrets (`DATABASE_URL`, `GITHUB_TOKEN`, `LLM_API_KEY`) are never passed to sandboxes. Sandbox env is an
  allow-list. AI output is schema-validated, path-restricted, and verified in the sandbox.
- The worker needs Docker access, which is root-equivalent on Linux. Run it on a dedicated host or VM.

## Architecture

```
src/app          Next.js pages + API routes (REST, SSE, downloads)
src/components   UI (graveyard scene, ECG monitor, terminal, dashboard)
src/engine       framework-free pipeline: core/ (state machine, workspace, patch, verification),
                 ecosystems/npm (analysis, runtime, diagnosis, strategies), ci/, llm/, report
src/sandbox      DockerSandbox
src/server       config, Prisma, job queue (SKIP LOCKED), DB event sink, GitHub metadata, rate limit
src/worker       worker process
.kiro/           specs, steering, hooks
```

To add a language or package manager, implement `Ecosystem` (`src/engine/ecosystems/types.ts`) and register
it in `src/engine/ecosystems/index.ts`.

## Testing

```bash
npm test                 # unit, property (fast-check), FakeSandbox pipeline, git apply integration
npm run test:docker      # opt-in: real containers (needs Docker)
REPOREVIVE_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/integration/db.test.ts   # opt-in: PostgreSQL
```

Property tests cover rollback correctness, patch consistency (also against real `git apply`), state
transitions, no-regression acceptance, health, URL parsing, and preservation of verified fixes across random
failure scenarios.

## Limitations (MVP)

- Public GitHub repositories only; root package only (workspaces/monorepos are analysed but not verified per package).
- npm is used for install even when only `yarn.lock`/`pnpm-lock.yaml` exist.
- CI fixes are verified statically; GitHub Actions is not executed.
- Tests that need network or external services fail in the sandbox by design.
- Dev-only advisories remain in `vitest@3` (dev server) and the `prisma` CLI's config loader; they do not ship
  in the runtime. Upgrading to Vitest 4 is blocked by an npm 10.9 resolver crash.
