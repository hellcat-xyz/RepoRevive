# Design: Repair engine upgrade

## Data model

- `IssueKind` gains nine kinds (see requirements R1.3).
- `Issue.diagnostic?: IssueDiagnostic` = `{ category, message, command?, file?, lifecycle?, package?, httpStatus?, resources? }`.
  `Issue.data` still carries string values strategies need (`file`, `lifecycle`, `resources`).

## Diagnosis (`ecosystems/npm/diagnose.ts`, pure)

Input gains optional `projectName` and `scripts`. New helpers in `ecosystems/npm/lifecycle.ts`:

- `parseLifecycleFailure(log)`: finds the last `> pkg@ver <hook>` header and the last `> <cmd>` line after it.
- `scriptFileFromCommand(cmd)`: `node|tsx|ts-node|bash|sh <file>` -> file.
- `resolveScriptChain(scripts, hook)`: expands `npm run X` chains from package.json to script files.
- `findHttpFailures(log)`: lines with `HTTP 404/410` that are not npm-registry lines; returns resource names.

Order of rules: existing specific rules first; then `broken-upstream-resource`, `lockfile-corrupt`,
`missing-script`, `missing-file`, `typescript-error`, `dependency-api-change`; then step fallbacks
(`lifecycle-script-failure`, `build-failure`, `test-failure`); `unknown` last.

## Upstream port

```ts
interface UpstreamResolver {
  commitAt(owner, repo, ref, untilIso): Promise<string | null>; // newest commit on ref at or before the date
  fileExists(owner, repo, sha, path): Promise<boolean>;
}
```

`GitHubUpstreamResolver` (`engine/upstream/github-http.ts`) calls only `api.github.com` (commits and contents endpoints), validates every segment with an allow-list regex, caps timeouts, and caches.

## Strategy: `upstream-ref-pin` (`ecosystems/npm/upstream-strategies.ts`)

1. Candidate files = `diagnostic.file` + files from `resolveScriptChain` + files referenced in the log.
2. Scan each for literal `https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>` where `<ref>` is not a 40-hex SHA.
3. For each distinct `<o>/<r>/<ref>`, `commitAt(commitDate)`; check `fileExists` for every failing resource under
   each base path found. Proposal only if every check passes.
4. Edit = replace the `<ref>` segment with the SHA. Invasiveness 2 (a source edit, but one token).

The sandbox then re-runs install/build/test. Acceptance stays with `decideAcceptance`.

## Pipeline changes

- `PipelineDeps.upstream?: UpstreamResolver`, passed through `StrategyContext.upstream`.
- `repairLoop` logs strategies consulted per issue and records a SUGGESTED attempt when none propose, so the stage
  never ends silently. Log sources: `diagnose`, `repair`, `patch`, `verify`.
- `Verifier` unchanged: failed installs are always re-run after an edit.

## Correctness properties (new)

- R-P1 A reverted candidate leaves the workspace byte-identical to before it.
- R-P2 Strategy edits never target paths outside the workspace; unsafe paths are rejected.
- R-P3 Every `VERIFIED` attempt carries verification evidence with at least one improved or resolved step.
- R-P4 The loop performs at most `maxAttempts` verification runs for any strategy set.
- R-P5 Report root causes and attempt counts match the recorded attempts.
- R-P6 `rewriteRawRefs` changes only the ref segment and is idempotent.
