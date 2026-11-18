# Requirements: AI-assisted source fixes

## Problem

The optional LLM strategy exists but is too weak to produce a useful pull request when the real fault is in
project source. Gaps found in the code:

- `referencedFiles` only recognises JS/TS/JSON/CSS paths, so Python, Rust, Go and Java failures send the model
  no source files at all.
- At most 4 files, with no view of the repository layout and no imported modules.
- `test-failure` is not a handled issue kind, so failing tests never reach the model.
- The model never sees why its earlier attempts failed, only their titles.
- Nothing stops an edit from weakening tests (skips, removed cases, `|| true`).
- A re-worded proposal with identical edits is tried again.
- The pull request does not say which changes came from a model.

## Requirements

### R1. Context
1. The model receives: manifests, the diagnostic file, files named in the log (JS/TS, Python, Rust, Go, Java/Kotlin,
   Vue, styles), their local imports one level deep (JS/TS relative imports, Python relative and in-repo module
   imports), and a bounded list of repository paths.
2. Limits: 10 files, 16 KB per file, 64 KB of file content in total. Forbidden paths (lockfiles, credentials,
   `node_modules`, workflows, ...) are never sent or editable.

### R2. Iteration
1. For one issue the strategy offers at most `LLM_MAX_ATTEMPTS_PER_ISSUE` proposals (default 3).
2. Earlier attempts for the same issue are sent first, with their outcome. A reverted attempt includes the tail of
   the first failing step after that attempt, so the model sees what its change did.
3. A proposal whose edits are identical to one already tried for the same issue is skipped, whatever its title.

### R3. Integrity (never weaken the project to pass)
An AI edit is rejected, with the reason logged, when it:
- reduces the number of test cases in a file, or empties a file;
- adds skip/ignore markers (`.skip`, `xit`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip(`, `@Disabled`, ...);
- adds `|| true`, `exit 0`, `--passWithNoTests` or `continue-on-error`;
- removes a `package.json` script, or turns `test`/`build` into an `echo`;
- adds `child_process`, `execSync`, `eval(`, `new Function(` or reads secret-looking env variables.

### R4. Scope
1. `test-failure` joins the issue kinds the strategy handles.
2. Up to 10 edits per proposal and 40 KB of replacement text. New files are allowed.
3. Every AI fix goes through apply, verify, accept or roll back. It is kept only when verification supports it.
   Labels are unchanged (verified runtime, reverted, suggested).

### R5. Pull request and report
1. The PR body has an "AI-assisted changes" section listing each kept AI fix and its files, and says it needs human
   review like any contribution.
2. The job page marks AI attempts with an "AI" chip.

### R6. Configuration
`LLM_MAX_ATTEMPTS_PER_ISSUE` (1..10, default 3) is validated in `config.ts`, listed in `.env.example` and the README.
The README recommends a stronger model than the default for source edits.

### R7. Tests
Unit and property tests for integrity checks and context building; a pipeline test (FakeSandbox, fake LLM) where a
source bug is fixed and appears in the patch; rejection, cap and dedupe cases; PR body section.
