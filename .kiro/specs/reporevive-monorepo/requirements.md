# Requirements: Multi-project repositories (MERN and monorepos)

## Problem

Detection runs once against the repository root. A repository whose projects live in sub-folders
(typical MERN layout: `client/package.json` and `server/package.json`, nothing at the root) ends
with `NO_SUPPORTED_PROJECT`. A root `package.json` that only orchestrates (`concurrently`,
`install-all`) is verified on its own, which says nothing about the real projects. The analyzer
currently only warns "Only the root package is verified in the MVP" for npm workspaces.

## Scope and assumptions

- Sub-projects are independent: each one installs, builds and tests inside its own folder.
- Tests run with `--network none` (existing rule). Tests that need a live service (MongoDB, Redis)
  fail at baseline and are reported as failures or suggestions. No test is skipped, deleted or
  weakened to make a step pass. Service containers are out of scope here.
- A sub-project that reads files outside its own folder (`file:../shared`, `../../tsconfig.base.json`)
  may fail at baseline. This is reported, not worked around.
- npm/yarn/pnpm workspaces roots stay a single project (the package manager handles the workspace).
  This feature does not change that.

## Requirements

### R1. Discovery

1. WHEN the root has no supported project THEN the system SHALL search sub-folders up to depth 2
   and treat each folder where an ecosystem's `detection()` returns a match as a sub-project.
2. WHEN the root is an npm project that looks like an orchestrator THEN the system SHALL also search
   sub-folders. Orchestrator means: no `workspaces`, no lockfile, no `build` script, no real `test`
   script, and at least one sub-project found.
3. WHEN the root is any other supported project THEN the system SHALL verify it and also the conventional companion folders directly under the root (client, rontend, server, ackend, pi, web, ui, pp, website, dmin) that contain a supported project. Other sub-folders (docs/, examples/) are not run. Package-manager workspaces stay one project.
4. The search SHALL skip `node_modules`, `.git`, `vendor`, `dist`, `build`, `target`, `venv`, `.venv`,
   `__pycache__`, `coverage`, hidden folders, symlinks, and folders that are inside an already
   detected sub-project.
5. The number of sub-projects run SHALL be capped by `MAX_SUBPROJECTS` (default 4, range 1..10).
   Extra projects are listed in the report as not run, with the reason.
6. Sub-project order SHALL be deterministic (sorted by path).

### R2. Execution

1. Each sub-project SHALL go through analyze, baseline, diagnose, repair and final verification with
   its own ecosystem, runtime image, install fingerprint and repair budget (`MAX_REPAIR_ATTEMPTS`
   per project).
2. The sandbox SHALL mount only the sub-project folder at `/workspace`. All existing sandbox rules
   (capabilities, read-only root, network policy, timeouts, labels) apply unchanged.
3. The job-level status SHALL follow the existing state machine, phase by phase: clone, analyze,
   baseline for all projects, diagnose for all, repair for all, final verification for all, report.
   No status string is written directly.
4. The job timeout SHALL be shared. WHEN time runs out THEN remaining projects are reported as not
   run and the job still completes with a report.
5. An error inside one project (strategy exception, verification crash, sandbox failure for that
   project) SHALL NOT abort the others. `CANCELLED` and Docker-unavailable errors still abort the job.
6. Every candidate fix keeps the existing transaction: apply, verify, decide, keep or roll back.

### R3. Patch

1. The job SHALL produce one patch. Paths from a sub-project are prefixed with its folder
   (`client/package.json`), so `git apply` from the repository root works.
2. The patch SHALL contain only kept candidates from all projects, plus verified static CI fixes.
3. `.github/workflows` fixes are applied once, at the repository root, after all projects finish.

### R4. Health and labels

1. Job health is computed from per-project results by a pure function:
   - `REVIVED` only when every project that ran is `REVIVED` and none was left unrun.
   - `PARTIALLY_REVIVED` when at least one project is `REVIVED` or `PARTIALLY_REVIVED` and the rule above is not met.
   - `UNRECOVERABLE` otherwise.
2. Every attempt SHALL carry the project folder it belongs to. Attempt labels (verified, verified
   static, reverted, suggested) are unchanged.
3. Single-project jobs SHALL keep the current report shape and UI. Old reports remain readable.

### R5. Report and UI

1. The report SHALL include `projects[]`: folder, ecosystem, package manager, runtime, health,
   baseline and final step summaries, and a `notRun` reason when applicable.
2. The job page SHALL show a project list with per-project health and let the user filter the
   repair attempts by project.
3. Markdown report and API output SHALL list each project in its own section.

### R6. Safety

1. Sub-project folder names SHALL pass `validateRelativePath` and the `Workspace` symlink checks
   before any read or mount.
2. The host SHALL NOT execute repository content or run `git` against the clone. Discovery only reads
   files through `Workspace`.
3. `MAX_SUBPROJECTS` is read through `src/server/config.ts`, documented in `.env.example` and the README.

### R7. Tests

1. Discovery has unit tests (MERN layout, orchestrator root, workspaces root, skip list, depth, cap, ordering) and a property test: result is deterministic and never exceeds the cap.
2. Health aggregation has a property test.
3. Pipeline tests on `FakeSandbox`: MERN fixture with one project repaired and one failing; patch paths are prefixed and apply to the original files; rollback leaves no trace across projects.
4. Single-root repositories behave as before (existing pipeline tests pass unchanged).
