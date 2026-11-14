# Requirements: Repair engine upgrade (actionable diagnosis and real repairs)

## Introduction

RepoRevive detected install failures it could not name ("The install step failed") and then finished the
repair stage without trying anything. The reference case is `hellcat-xyz/OrexisAI` at commit
`fb7ffcdbbd358a6f7186a65381b6d2837a669f18`: `npm ci` fails in the project's own `postinstall`
(`npm run build:hyperspeed` -> `node scripts/build-reactbits-hyperspeed.mjs`) with
`Unable to download official ReactBits HyperSpeedPresets.js: HTTP 404`.

## Root cause (confirmed in code)

1. `diagnoseNpmOutput` has no rule for lifecycle-script failures or HTTP 404s from external hosts, so the
   failure falls through to `kind: 'unknown'`.
2. The only strategy that handles `unknown` is the optional LLM strategy. Without `LLM_API_KEY` no strategy
   matches, `repairLoop` finds no proposal and breaks on its first iteration. Nothing is logged about why.
3. Even with an LLM, the model cannot see why the URL fails (upstream moved/removed a file), so it can only guess.

## Requirements

### R1: Actionable diagnosis

1. WHEN a step fails, THE engine SHALL classify it into the most specific `IssueKind` available and SHALL use
   `unknown` only when nothing more specific applies.
2. Each issue SHALL carry a structured `diagnostic`: category, message, and when known the command, the
   affected file, the lifecycle script name, the HTTP status, and the failing resources.
3. New kinds: `lifecycle-script-failure`, `broken-upstream-resource`, `missing-file`, `missing-script`,
   `lockfile-corrupt`, `typescript-error`, `dependency-api-change`, `build-failure`, `test-failure`.
4. Every new kind SHALL have a diagnoser rule, a report explanation, and a test.
5. WHEN the failing lifecycle script belongs to a dependency (not the project), THE diagnosis SHALL say so and
   SHALL NOT propose editing project files.

### R2: Deterministic repair of broken upstream resources

1. WHEN a project script downloads from `raw.githubusercontent.com/<owner>/<repo>/<floating-ref>/...` and the
   download fails with 404/410, THE `upstream-ref-pin` strategy SHALL resolve the floating ref to the upstream
   commit that was current at the repository's own commit date and rewrite the ref to that commit SHA.
2. THE strategy SHALL check, through the `UpstreamResolver` port, that each resource named in the failure exists
   at the resolved commit. IF any does not, it SHALL propose nothing.
3. THE strategy SHALL NOT invent file content, change URLs to other hosts, bypass the script, or edit lockfiles.
4. THE strategy SHALL work for any script path found through the failing lifecycle chain or the error output;
   nothing is specific to one repository.

### R3: Repair loop transparency and bounds

1. EVERY issue the loop considers SHALL produce a log line naming the strategies consulted and why none applied.
2. WHEN no strategy can propose a fix, THE engine SHALL record a `SUGGESTED` attempt with the reason.
3. Repair attempts SHALL never exceed `maxAttempts` verification runs.
4. A candidate is kept only when `decideAcceptance` accepts it. Otherwise the workspace is rolled back.
5. The patch SHALL contain only kept candidates.
6. Health SHALL be `REVIVED` only if the final clean verification passes every required step.

### R4: Logging and UI

1. Events SHALL reflect real activity and use the existing `log` event with a `source` tag.
2. The Terminal SHALL colour the new sources (`scan`, `patch`, `verify`, `report`, `upstream`).

### R5: Security

1. Untrusted code still runs only in the sandbox. The host performs only GitHub metadata GETs to
   `api.github.com` only (commits and contents endpoints), with strict owner/repo/ref validation, timeouts, size caps,
   and no redirects off those hosts.
2. Edits go through `Workspace` (path validation, symlink refusal).
3. `GITHUB_TOKEN` is used only for `api.github.com` requests from the host and never reaches a sandbox.
