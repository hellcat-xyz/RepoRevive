# RepoRevive

Bring dead GitHub repositories back to life. Paste a public repository URL; RepoRevive detects its ecosystem,
clones it into a locked-down Docker sandbox, records why it fails today, applies targeted fixes one at a time,
keeps only the fixes that verification supports, and gives you a report plus a `git apply`-compatible patch.
If you explicitly choose to, it also opens a **draft pull request** with exactly those verified changes.

## Supported ecosystems

| Ecosystem | Detected from                                                                              | Package managers                    | Install / build / test in the sandbox                                            | Image                                    |
| --------- | ------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| Node.js   | `package.json`                                                                             | npm, pnpm, Yarn (Classic and Berry) | `npm ci` or the manager's frozen install; `run build`; `run test`                | `node:<major>`                           |
| Python    | `pyproject.toml`, `requirements*.txt`, `setup.py/cfg`, `Pipfile`, `poetry.lock`, `uv.lock` | pip, Poetry, uv, Pipenv             | venv + install; `compileall` (byte-compile check); `pytest` or `unittest`        | `python:3.<minor>-slim`                  |
| Rust      | `Cargo.toml`, `Cargo.lock`, `rust-toolchain[.toml]`                                        | Cargo (workspaces)                  | `cargo fetch`; `cargo check --workspace --all-targets`; `cargo test --workspace` | `rust:1.<minor>-slim`                    |
| Go        | `go.mod`, `go.sum`, `go.work`                                                              | Go modules                          | `go mod download`; `go build ./...`; `go test ./...`                             | `golang:1.<minor>`                       |
| Java      | `pom.xml`                                                                                  | Maven                               | `dependency:go-offline`; `test-compile`; `test`                                  | `maven:3.9-eclipse-temurin-<8,11,17,21>` |
| Static    | `index.html` (or any root `*.html`) with no manifest                                       | none                                | nothing is run; local references in HTML/CSS are checked                         | none                                     |

Static sites are a fallback: any repository with a manifest is treated as that ecosystem. Fixes are labelled **verified (static)**, never verified (runtime), because nothing is executed. Only references whose target exists in another letter case are rewritten; missing files are never invented.

Gradle is **not** supported yet and is not detected. Detection is scored (confidence 0..1); if two ecosystems score
close together the job reports the ambiguity and uses the higher-ranked one.

### Multi-project repositories (MERN and monorepos)

Projects in sub-folders are found and verified one by one, each in its own sandbox runs with its own runtime and repair budget.

- Root without a project, or a root `package.json` that only orchestrates (no workspaces, lockfile, build or test script): every project up to two folders deep is verified (for example `client/` and `server/`).
- Root that is a project: it is verified, plus conventional companion folders (`client`, `frontend`, `server`, `backend`, `api`, `web`, `ui`, `app`, `website`, `admin`).
- npm/Yarn/pnpm workspaces and Cargo/Go workspaces stay one project; the package manager handles the workspace.
- `MAX_SUBPROJECTS` (default 4) caps how many projects run; the rest are listed as not run.
- One patch covers everything, with paths relative to the repository root (`client/package.json`). Health is `REVIVED` only when every project is revived.
- A sub-project is mounted on its own, so references outside its folder (`file:../shared`) can fail at baseline. Tests that need MongoDB or another live service fail under `--network none` and are reported as failures; no test is skipped or removed.

### AI-assisted source fixes (optional)

Set `LLM_API_KEY` (and optionally `LLM_BASE_URL`, `LLM_MODEL`) to let RepoRevive fix problems in project source, not
only in manifests. It is the last strategy tried, after every deterministic one.

- The model sees the failing log, the files it points at (JS/TS, Python, Rust, Go, Java/Kotlin), the local files those
  import, and the repository layout. After a reverted attempt it also sees the log of what that change caused.
- It may edit up to 10 files per proposal (and create new ones). Every proposal is applied, verified in the sandbox, and
  rolled back unless it helps. `LLM_MAX_ATTEMPTS_PER_ISSUE` (default 3) bounds the tries per issue; an identical
  proposal is never tried twice.
- Edits that weaken the project are rejected before they run: fewer tests, skipped tests, `|| true`, `exit 0`,
  removed or no-op scripts, new `child_process`/`eval`, lockfiles, workflows, and credential files.
- Kept AI fixes appear in the pull request under "AI-assisted changes" and must be reviewed like any contribution.
- The default `gpt-4o-mini` is cheap but limited. For real source repairs use a stronger model through `LLM_MODEL`.
### What gets repaired (deterministic strategies, tried before any AI edit)

| Ecosystem | Strategies                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js   | peer-conflict config, git:// URL rewrite, node-sass to sass, era-matched Node pin, dependency pins, broken upstream downloads, CI modernisation (static)                                                                                                                     |
| Python    | unavailable versions re-pinned to era releases (PyPI), resolver conflicts relaxed, lockfile regeneration (Poetry/uv/Pipenv), Python version pin (`.python-version`), missing dependencies added (only if they exist on PyPI), pytest `pythonpath`, `collections` ABC rewrite |
| Rust      | missing/yanked crates re-pinned (crates.io), toolchain pin (`rust-toolchain.toml`) for rustc/edition mismatches, `Cargo.lock` regeneration, nonexistent features removed, missing crates added                                                                               |
| Go        | `go mod tidy` for stale `go.sum`/missing modules, unavailable module versions re-pinned (Go proxy), `.go-version` toolchain pin. Checksum mismatches are never auto-fixed                                                                                                    |
| Java      | blocked `http://` repositories upgraded to https, unavailable artifact versions re-pinned (Maven Central), JDK pin (`.java-version`)                                                                                                                                         |
| All       | optional AI source repair (any ecosystem): schema-validated search/replace edits, verified like every other fix                                                                                                                                                              |

Nothing here is guaranteed to fix a given repository; each fix is kept only if verification supports it.

### Verification semantics

The report separates _what ran_ from the health score. `coverage.level` is `full` (install, build and tests passed),
`build-only` (no test suite found), `install-only`, `failing` or `blocked`. A project without tests can be
`REVIVED` but is never described as functionally tested. Python's build step is a byte-compile syntax check, not a
package build; packaging is exercised by the install step (`pip install -e .`). Verification runs in RepoRevive's
sandbox; it is not a GitHub Actions run.

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

The first resurrection of each ecosystem pulls its runtime image, which takes a few minutes once.

### Optional: GitHub pull requests

Patch download works with no GitHub configuration. To enable pull requests, create a **GitHub App**
(Settings, Developer settings, GitHub Apps, New):

1. **Callback URL**: `<APP_BASE_URL>/api/github/callback` (e.g. `http://localhost:3000/api/github/callback`). Enable _Request user authorization (OAuth) during installation_ and keep _Expire user authorization tokens_ on. Webhooks can stay disabled.
2. **Repository permissions** (minimum): _Contents: Read and write_, _Pull requests: Read and write_, _Metadata: Read-only_. For the fork path also _Administration/Repository creation: write_ (needed by `POST /repos/{owner}/{repo}/forks`). Do **not** grant _Workflows_: workflow files are never published.
3. Generate a client secret, then set the variables below in `.env` and restart web and worker.
4. Install the app on the accounts/repositories you want to publish to. A GitHub App user token can only write where the app is installed and the user has access; RepoRevive cannot fork or push to an unrelated repository on its own, and reports that as _blocked_.

| Variable                                            | Purpose                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | OAuth credentials of the GitHub App                                                         |
| `GITHUB_APP_SLUG`                                   | App slug, used for the install link                                                         |
| `APP_BASE_URL`                                      | Public origin of this app (OAuth redirect and CSRF origin check)                            |
| `SESSION_SECRET`                                    | 32+ random characters; signs session and OAuth-state cookies                                |
| `TOKEN_ENCRYPTION_KEY`                              | base64 of 32 random bytes (`openssl rand -base64 32`); encrypts stored tokens (AES-256-GCM) |

If none are set, GitHub features are off and the UI says so. Setting only some is a startup error.

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

## Publishing pull requests

Choose a mode before starting a job (default **Patch only**, identical to earlier versions):

| Mode            | Behaviour                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Patch only      | Download the patch and report. Nothing touches GitHub.                                                                        |
| Review, then PR | After verification the diff is shown; a draft PR is created only after you click _Approve_.                                   |
| Automatic PR    | You opt in when starting the job. When the repair passes the publication policy, a draft PR is opened without another prompt. |

How it works: a privileged step in the worker (never the sandbox) uses your encrypted GitHub token and the Git Data API. It checks
that the base branch still points at the commit that was verified (otherwise it stops with a _drift_ message), creates a new branch`reporevive/fix-<job>` (never the default branch, never a force-push), commits exactly the accepted file changes, and opens a **draft** PR with
an honest description. If you cannot push to the repository it uses your fork only if you ticked _allow fork_. Retrying is safe: one publication row
per job, a deterministic branch, and remote reconciliation mean a retry or worker restart reuses the existing branch and PR.
RepoRevive never merges, approves, or bypasses branch protection. Policy requires a verified REVIVED result (partial repairs need a separate
opt-in), at least one publishable file, and the job owner. Workflow files, binary files, symlinks and submodule changes are not published; they stay in the patch.

## Architecture

```
src/app          Next.js pages + API routes (REST, SSE, downloads)
src/components   UI (graveyard scene, ECG monitor, terminal, dashboard)
src/engine       framework-free pipeline: core/ (state machine, workspace, patch, verification, image allow-list, coverage),
                 ecosystems/{npm,python,rust,go,maven}, publish/ (policy, state machine, publisher, GitHub REST), ci/, llm/, report
src/sandbox      DockerSandbox
src/server       config, Prisma, job queue (SKIP LOCKED), DB event sink, GitHub OAuth/crypto/sessions, publications, rate limit
src/worker       worker process
.kiro/           specs, steering, hooks
```

To add a language or package manager, implement `Ecosystem` (`src/engine/ecosystems/types.ts`) and register
it in `src/engine/ecosystems/index.ts`.

## Testing

```bash
npm test                 # unit, property (fast-check), FakeSandbox pipeline, git apply integration
npm run test:docker      # opt-in: real containers for every ecosystem image (needs Docker)
REPOREVIVE_GITHUB_LIVE_TESTS=1 GITHUB_TEST_TOKEN=... GITHUB_TEST_REPO=you/sandbox-repo npx vitest run tests/integration/github-live.test.ts   # opt-in, WRITES a draft PR to a repo you own
REPOREVIVE_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/integration/db.test.ts   # opt-in: PostgreSQL
```

Property tests cover rollback correctness, patch consistency (also against real `git apply`), state
transitions, no-regression acceptance, health, URL parsing, and preservation of verified fixes across random
failure scenarios.

## Troubleshooting

- _GitHub integration is not configured_: set all five GitHub variables (above) and restart.
- _Reconnect your GitHub account_: the token expired or was revoked; use _Reconnect GitHub_ on the job page.
- _Base branch moved_: the repository changed during the run; start a new resurrection on the new commit.
- _Publication blocked, not retryable_: the cause is shown on the job page; the patch and report remain downloadable.
- Worker log lines starting with `[publish]` show publication outcomes.

## Limitations

- Public GitHub repositories only. Projects in sub-folders are verified separately (see Multi-project repositories); package-manager workspaces count as one project.
- Python/Rust/Go/Maven/pnpm/Yarn support was verified with scripted-sandbox tests and unit tests; the real-container tests (`npm run test:docker`) and live PR test are opt-in and were not executed in the environment this was written in.
- Maven offline test runs can fail when Surefire providers were not pre-fetched; Gradle is unsupported.
- Rust/Python projects needing system libraries (OpenSSL headers, libpq) cannot be fixed: images are not customised.
- Fork publication depends on the GitHub App's permissions and installation (see above) and should be confirmed with the live test.
- Yarn Berry/pnpm install use tools fetched into the job cache at install time.
- CI fixes are verified statically; GitHub Actions is not executed.
- Tests that need network or external services fail in the sandbox by design.
- Dev-only advisories remain in `vitest@3` (dev server) and the `prisma` CLI's config loader; they do not ship
  in the runtime. Upgrading to Vitest 4 is blocked by an npm 10.9 resolver crash.
