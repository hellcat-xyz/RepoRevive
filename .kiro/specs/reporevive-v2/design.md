# RepoRevive V2 — Design

## Layers (unchanged direction: app → server → engine/core)

```
engine/core/images.ts          pure image allowlist + family cache env
engine/core/command.ts         validated argv type
engine/core/coverage.ts        verification coverage (separate from score)
engine/ecosystems/registry     ranked detection with confidence/ambiguity
engine/ecosystems/{npm,python,rust,go,maven}/   Ecosystem implementations
engine/publish/                host-side PR publishing (no Next/Prisma imports)
  state.ts      publication state machine
  policy.ts     can-publish decision (pure)
  changes.ts    FileChange -> GitHub tree entries, rejects unsupported content
  body.ts       PR title/body
  github-port.ts GitHubApi port (+ HTTP implementation in github-rest.ts)
  publisher.ts  orchestrator: authorize → drift check → resolve target → branch → commit → draft PR
server/github/                  OAuth (state/CSRF), crypto, token store, session
server/publication.ts           Prisma persistence of publication rows and idempotency
```

## Ecosystem interface additions

`detection(ws)` returns confidence+evidence. `sandboxEnv(runtime)` returns allow-listed env.
`RuntimeSelection` gains `family` and `version` (Node `major` keeps its meaning; Python's `major` is 3
and `version` is `3.11`). `StepPlan.command` is validated by `assertSafeCommand`.

## Python plan (package manager → commands, all inside `python:<ver>-slim`)

A venv lives in `/cache/venv`, which persists across steps of one job. pip: `pip install -r` files and/or
`pip install .`. Poetry/uv/Pipenv are installed into the venv (network on install step only). Build step is
`python -m compileall` (syntax check; not a package build). Test step: pytest or unittest only when present.

## Rust plan

`rust:<ver>` images. install = `cargo fetch` (network), build = `cargo check --workspace --all-targets`
(`--offline` implicit through network none after fetch), test = `cargo test --workspace`. `CARGO_HOME=/cache/cargo`.

## Publication data flow

```
job COMPLETED → patch + FileChange[] persisted (Resurrection.publishChanges Json) → Publication row
(unique per resurrection) → worker/route runs Publisher with user token → events (SSE) → row updated
```

The Publisher is given `GitHubApi` and a `PublicationStore` port. Each step persists the remote refs
it created (branch name, commit sha, PR number) before moving on, so a retry reconciles instead of recreating.
Idempotency: branch name `reporevive/<jobId8>`; PR lookup by `head` before create; DB `@@unique(resurrectionId)`.

## Security decisions

- GitHub App user access tokens (expiring) are stored AES-256-GCM encrypted with a key from env.
- OAuth state: 32 random bytes, stored in an HttpOnly SameSite=Lax cookie, compared in constant time; the
  callback consumes it.
- Session: HMAC-signed HttpOnly cookie holding a user id. Mutating routes check owner server-side.
- Fork flow needs a _user_ token with `public_repo`-equivalent fork permission; GitHub App user tokens are
  limited by the app's permissions and the user's access. When the app lacks it, the result is `BLOCKED`.
- HTTP client uses fetch with timeouts and bounded retries; an Octokit dependency was not added because the
  five endpoints used are thin and the port keeps the publisher fully testable.

## Failure handling

Errors map to `PublishError` codes (RATE_LIMITED, FORBIDDEN, AUTH_EXPIRED, DRIFT, CONFLICT, NETWORK,
EMPTY_PATCH, UNSUPPORTED_CHANGE, POLICY). Retryable codes go to `FAILED(retryable)`; others to `BLOCKED`.

## Decisions recorded during implementation

- **Workflow files are never published.** .github/workflows/** changes (CI modernisation) stay in the patch; publishing them needs the workflows permission and a human review. They are listed as excluded in the PR body and UI.
- **Idempotency layers:** one Publication row per job (@unique resurrectionId, @unique idempotencyKey), compare-and-set status updates, a lock with expiry, deterministic branch name, adoption of our own branch by the RepoRevive-Publication: commit trailer, and PR lookup by head before creation.
- **Concurrency:** two jobs for the same repository and base SHA cannot both publish (hasConflictingActive, application-level check; there is no partial unique index because Prisma cannot express one).
- **Fork flow limits:** GitHub App user tokens only act where the app is installed; forking needs the app's repository-creation permission. If GitHub refuses, the publication is BLOCKED with the reason.
- **Package managers for Node:** pnpm/Yarn are installed into /cache/pm during the networked install step and run from there. Build/test stay offline.
- **Registries:** PyPI, crates.io, Go proxy and Maven Central search are read-only metadata GETs behind PackageRegistry.

## Static site ecosystem (`src/engine/ecosystems/static/`)

- `references.ts`: pure extraction (`extractHtmlReferences`, `extractCssReferences`), `localTarget`, case-exact
  `resolveExact`, `rewriteReference`, and `findBrokenReferences(ws)`. Reads only through `Workspace`.
- `index.ts`: `Ecosystem` with `fallback: true` and `verification: 'static'`; `staticIssues` is the diagnoser.
- `strategies.ts`: `static-reference-case-fix` (invasiveness 2, proposals have `kind: 'static'`).
- Pipeline: proposals with `kind: 'static'` that pass verification are recorded `VERIFIED_STATIC`. Health for
  static-only projects comes from `computeStaticHealth` (remaining issues), not from skipped steps.
- `Verifier` pulls a runtime image only when the plan has a command, so a static site never starts Docker.