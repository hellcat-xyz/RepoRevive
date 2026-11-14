# Repair Strategies and Verification

Applies to everything under `src/engine/**/strategies*`, `upstream-strategies.ts`, `diagnose.ts`, and the
repair loop in `pipeline.ts`.

## Diagnosis

- Classify into the most specific `IssueKind`. `unknown` is the last resort, and `build-failure` /
  `test-failure` / `lifecycle-script-failure` come before it.
- Fill `Issue.diagnostic` (category, message, command, file, lifecycle, httpStatus, resources) when known.
  Strategies read it; the UI and report show it.
- A new kind needs: diagnoser rule, entry in `ISSUE_EXPLANATIONS`, and a test using a realistic log fixture.

## Strategies

- One family per file, exporting `FixStrategy` objects. Declare `handles` and `invasiveness`.
- Prefer, in order: config (1), runtime pin (2), era-matched pin of an existing reference (2), dependency pin or
  add (3), replacement (4), source edit by LLM (5).
- Never fabricate upstream content. Only rewrite references to something that provably exists (check through a port).
- Never delete tests, skip tests, remove lifecycle scripts, or add `|| true` to make a step pass.
- Propose nothing when unsure. A strategy that cannot help returns `[]` and logs why through `ctx.log`.

## Transactions

- Every candidate: `ws.applyEdits` -> `verifier.verify` -> `decideAcceptance` -> keep or `ws.rollback`.
- Any exception during verification must roll the candidate back before rethrowing.
- The patch is built from `ws.changes()`, so it can only contain kept candidates.
- Repair attempts are bounded by `maxAttempts`; each distinct proposal is tried at most once.

## Reporting vocabulary

`VERIFIED` (runtime), `VERIFIED_STATIC`, `REVERTED`, `SUGGESTED` (unverified), `ERROR`. Health is `REVIVED` only when the
final clean verification passes every required step.

## Logging

Use `source` tags the Terminal knows: `clone`, `analyze`, `baseline`, `diagnose`, `repair`, `patch`, `verify`, `report`,
`install`, `build`, `test`. Log real activity only.

## Host-side network

The host may only perform read-only GETs to `api.github.com` (via `UpstreamResolver`) and the npm registry (via `PackageRegistry`). Validate every URL component. Repository code
never runs on the host.
