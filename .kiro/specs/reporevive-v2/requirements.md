# RepoRevive V2 — Requirements

Scope: multi-ecosystem recovery (npm/pnpm/yarn, Python, Rust, Go, Maven) and an explicit-consent GitHub
draft pull request workflow. Existing behaviour (npm repair, rollback, patch/report download, SSE,
cancellation, worker) is preserved.

## Baseline findings (Phase 1 inspection)

- `Ecosystem.detect` is boolean and first-match; no confidence or ambiguity.
- `RuntimeSelection` assumes a Node-style `major`; `DockerSandbox` accepts only `node:\d+`.
- Pipeline hard-codes `NOT_A_NODE_PROJECT`, a Node-only `SANDBOX_ENV`, and an npm cache variable.
- Only npm is installed with `npm ci`; pnpm/yarn lockfiles are ignored.
- Scoring (40/30/30) treats "no tests" as OK, so a missing suite looks like a passing suite.
- No users, ownership, or GitHub integration exist. Jobs are anonymous, rate-limited by IP.
- No CI workflow for RepoRevive itself.

## R1 Ecosystem detection

1. Each ecosystem reports `{confidence 0..1, evidence[]}` or null. Registry ranks by confidence, then by
   declared precedence. If the runner-up has confidence >= 0.6 and is within 0.15 of the winner, the result
   is flagged `ambiguous` and the pipeline logs and reports it.
2. The selected ecosystem is persisted on the job; strategies from one ecosystem are never run on another.
3. Detection is deterministic: same files, same result.

## R2 Runtime and sandbox

1. `RuntimeSelection` carries `family`, `version`, `image`, `label`, `source`, `warnings`.
2. Only images matching the allowlist in `engine/core/images.ts` may run (node, python, rust, golang,
   maven+temurin). Repository files and LLM output can never name an image.
3. Cache directories and environment variables are per ecosystem. Env keys are allow-listed.
4. Existing hardening is unchanged: cap-drop ALL, no-new-privileges, read-only root, non-root, limits,
   no Docker socket, network `none` for build/test unless configured.

## R3 Python

Detect pip/Poetry/uv/Pipenv from the listed files. Analyze deps, python requirement, build backend, test
framework, frameworks. Plan install, byte-compile build, and pytest/unittest. Diagnose: missing module,
version mismatch, unavailable version, resolver conflict, lockfile problems, legacy syntax, removed stdlib
API, import path. Repairs are deterministic first; LLM last. Missing tests => `no-test-suite`, never "passed".

## R4 Rust

Detect Cargo, lockfile, toolchain files, workspaces. Analyze package, edition, members, features, build
script. Plan `cargo fetch`, `cargo check --workspace --all-targets`, `cargo test --workspace`. Diagnose
missing/yanked crate, conflicts, edition/toolchain mismatch, stale lockfile, feature errors, compiler errors.

## R5 Go, Maven, pnpm, Yarn

Each ships a detector, runtime, plan, diagnoser, tests and report integration before being advertised in UI.

## R6 Verification honesty

`Verification coverage` is computed separately from score: installation, build, tests each one of
`passed | failed | skipped-not-applicable | no-test-suite | blocked`. Health REVIVED with no test suite
is flagged `coverage: build-only` in the report and PR body.

## R7 AI repair

Prompt includes ecosystem, package manager, runtime, command, diagnostics, prior attempts. Output is
zod-validated; paths validated; sizes bounded; search/replace must match exactly once; no shell commands;
workflow/credential files forbidden; verified like any other fix.

## R8 GitHub authentication

GitHub App with user-to-server OAuth. State is random, HMAC-bound to a cookie, single use. Tokens are
AES-256-GCM encrypted at rest, never sent to the client, LLM, logs, or sandboxes. Disconnect revokes the
grant and deletes credentials. Expired tokens refresh; revoked tokens mark the connection `REVOKED`.

## R9 Publishing

1. Modes: `PATCH_ONLY` (default), `REVIEW_PR`, `AUTO_PR`. Auto requires an explicit flag at submission by an
   authenticated owner.
2. Publication is a privileged host-side operation using GitHub REST (Git Data API). Sandboxes never get
   credentials. Nothing is merged, approved, or force-pushed. Default branch is never modified.
3. Direct-branch when the user has push permission; otherwise fork (only when allowed), wait for fork,
   cross-repo draft PR; otherwise `BLOCKED` with an explanation. Patch stays downloadable.
4. Base drift: base SHA is compared with the SHA the repair verified; drift blocks publication.
5. Idempotent: a unique key per job, DB unique constraint, deterministic branch name, remote reconcile
   (existing branch/PR is adopted, not duplicated). Bounded retries with backoff for 5xx/rate limit/network.
6. Only accepted edits are published; binary/symlink/submodule/oversize changes are rejected.
7. Policy: no empty PRs; final verification must have install passed and build/test not failed; partial
   repair requires a separate opt-in. PR body never claims tests passed when skipped and never claims
   GitHub CI success.
8. State machine: `NOT_REQUESTED → PENDING_APPROVAL → QUEUED → AUTHORIZING → PREPARING_BRANCH →
PUBLISHING_COMMIT → CREATING_PR → CREATED`; terminals `FAILED`, `BLOCKED`, `CANCELLED`,
   `AUTH_EXPIRED` (retryable).

## R10 Ownership

Every job has an optional owner. Owned jobs require the owner's session for cancel, publish, and
reading publication state. Anonymous historic jobs remain readable and patch-only.

## R11 UI

Ecosystem list on the homepage, publishing mode selector, GitHub connect control, live ecosystem/runtime/
verification panel, PR panel with "View Pull Request". All controls call real endpoints.

## R12 Tests

Vitest + fast-check. Properties: image allowlist, ecosystem isolation, path safety, publication state
machine, idempotent retries, no publish without authorization, published tree equals accepted edits,
failed repair never labelled verified. Docker and live GitHub tests are opt-in.

## R8 Static sites (HTML/CSS/JS without a build system)

1. Detection: `index.html` (or any `*.html`) at a project root, confidence 0.5 / 0.4. It is a fallback: any
   ecosystem with a manifest wins. In sub-folder discovery it applies only to conventional folder names
   (`client`, `frontend`, `web`, ...), never to `public/` or `docs/`.
2. Nothing is installed, built or run. All three steps are `skipped` with `not-applicable`, and the report says
   so (coverage level `none`, "nothing was executed").
3. The only check is a read-only scan of local references in HTML (`src`, `href`, `poster` on script, link,
   img, source, video, audio, iframe, a, ...) and CSS (`url()`, `@import`). References are checked
   case-exactly, because Linux hosts and GitHub Pages are case-sensitive.
4. Issue kind `broken-reference` (step `static`). The only automatic fix rewrites a reference to the existing
   file whose name differs only by letter case. Nothing is created, deleted or guessed.
5. Accepted fixes are labelled `VERIFIED_STATIC`, never `VERIFIED`. Health is `REVIVED` only when no broken
   reference remains; fewer than before is `PARTIALLY_REVIVED`.
6. Limits: JavaScript syntax and behaviour are not checked; references built by scripts, templating
   placeholders, `<base href>` pages and URLs outside the repository are skipped.

## R9 Pull request content

1. When a kept fix came from the AI strategy, the PR body lists it under "AI-assisted changes" with its files and a review notice (see .kiro/specs/reporevive-llm-source-fixes).
