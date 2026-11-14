# Requirements: RepoRevive MVP

## Introduction

RepoRevive analyzes, diagnoses, and repairs abandoned public Node.js/npm GitHub repositories inside
isolated Docker sandboxes, verifies each fix, and delivers a resurrection report and a `.patch` file.
Acceptance criteria use EARS notation.

## Glossary

- **Resurrection**: one job for one repository at one commit.
- **Step**: one verification command class: `install`, `build`, `test`.
- **Step result**: `passed | failed | timeout | skipped` with exit code, duration, and log tail.
- **Verification result**: the set of step results for one workspace state.
- **Issue**: a detected problem with `kind`, `fingerprint`, `step`, `evidence`, `severity`.
- **Fix**: file edits from one strategy for one issue, with a verification label.

---

### Requirement 1: Submit a repository

**User story:** As a developer, I want to paste a GitHub URL and start a resurrection, so that I can
revive a project without manual setup.

1. WHEN a user submits a URL of the form `https://github.com/<owner>/<repo>` (optionally `.git`,
   trailing slash, `www.`, or a `/tree/<ref>` suffix) THEN the system SHALL normalize it and create a
   queued resurrection, returning its id.
2. IF the URL is not a GitHub repository URL THEN the system SHALL reject it with a validation error
   before performing any network or process call.
3. IF the GitHub API reports the repository as missing or private THEN the system SHALL fail the
   job with code `REPO_NOT_FOUND_OR_PRIVATE` and explain that private repositories are out of scope.
4. IF the repository exceeds the configured size limit THEN the system SHALL fail with
   `REPO_TOO_LARGE`.
5. WHEN a client submits more than the configured number of jobs per minute THEN the system SHALL
   respond with HTTP 429.

### Requirement 2: Repository analysis

**User story:** As a developer, I want to see what the repository contains, so that I understand
the context of the failures.

1. WHEN a job starts THEN the system SHALL shallow-clone the repository inside a sandbox container
   and record the commit SHA and commit date.
2. WHEN the clone completes THEN the system SHALL inspect `package.json`, lockfiles
   (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`), Node version
   declarations (`.nvmrc`, `.node-version`, `engines.node`, `volta.node`), scripts, test presence,
   source language mix, and `.github/workflows/*.yml`.
3. IF no `package.json` exists at the repository root THEN the system SHALL mark the job
   `UNRECOVERABLE` with code `NOT_A_NODE_PROJECT`.
4. WHEN a non-npm lockfile is the only lockfile THEN the system SHALL record a warning and proceed
   with npm.
5. WHEN analysis completes THEN the system SHALL report static findings: deprecated packages,
   insecure `git://` dependencies, EOL Node declarations, and outdated CI configuration.

### Requirement 3: Baseline and failure detection

1. WHEN analysis completes THEN the system SHALL select a Node runtime from the repository's own
   declarations (`.nvmrc` > `.node-version` > `volta.node` > `engines.node`) mapped to a supported
   major, defaulting to the current LTS.
2. The system SHALL run `install`, then `build` (if a `build` script exists), then `test` (if a
   non-placeholder `test` script exists), and record the baseline verification result.
3. IF `install` fails THEN `build` and `test` SHALL be recorded as `skipped` (blocked).
4. WHEN a step fails THEN the system SHALL derive issues from its output, including: peer
   dependency conflicts (ERESOLVE), missing package versions (ETARGET), unpublished packages
   (E404), lockfile drift, `git://` protocol failures, native build failures (node-gyp, node-sass),
   Node engine mismatches, OpenSSL legacy errors, missing modules, missing binaries, and type errors
   inside `node_modules/@types`.
5. IF a step exceeds its timeout THEN the system SHALL kill the container and record `timeout`
   with an issue of kind `timeout`.
6. IF the test script is missing or is the npm placeholder THEN the system SHALL record
   `skipped` with reason `no-test-suite` and SHALL NOT treat it as a failure.

### Requirement 4: Iterative repair

1. WHEN issues exist THEN the system SHALL choose candidate fixes, least invasive first:
   configuration (`.npmrc`, `.nvmrc`) before dependency edits, and era-matched versions (published
   on or before the repository's last commit) before latest versions.
2. The system SHALL apply exactly one fix at a time and verify it before trying the next.
3. The system SHALL NOT upgrade a dependency unless an issue directly implicates it.
4. WHEN a fix is verified and accepted THEN the system SHALL re-diagnose from the new result,
   because fixing one step can reveal the next failure.
5. The system SHALL try each (issue fingerprint, strategy) pair at most once and SHALL stop after
   the configured maximum attempts or total time budget.
6. WHERE an LLM provider is configured, IF no rule-based strategy applies to an issue THEN the
   system MAY request edits from the LLM and SHALL validate and verify them like any other fix.

### Requirement 5: Verification and rollback

1. WHEN a fix is applied THEN the system SHALL rerun install (only if install inputs changed:
   manifest, lockfile, `.npmrc`, or runtime), build, and test.
2. The system SHALL accept a fix only if no previously passing step now fails AND (a previously
   failing step now passes OR the targeted issue fingerprint is gone and no new issue appears in an
   earlier step).
3. IF a fix is rejected THEN the system SHALL restore every touched file to its exact prior bytes
   (deleting files the fix created) and mark the attempt `reverted`.
4. Static fixes (CI workflows) SHALL be accepted only if the edited file parses and the targeted
   rule no longer matches; they SHALL be labelled `verified-static`.
5. WHEN repairs finish THEN the system SHALL run a final clean verification and record it.

### Requirement 6: Report and patch

1. WHEN a job finishes THEN the system SHALL produce a report with: root causes, modified files,
   per-attempt outcomes with labels, dependency changes, baseline vs final step results,
   remaining issues, warnings, and recommendations.
2. The system SHALL produce a Git-compatible unified diff (`diff --git` headers, new/deleted file
   modes) containing only accepted fixes, downloadable as `<owner>-<repo>-revived.patch`.
3. Applying the patch with `git apply` to the original commit SHALL reproduce the final files.
4. Suggested (unverified) changes SHALL be shown separately and SHALL NOT be in the verified patch.
5. The final health SHALL be: `REVIVED` if every applicable step passes; `PARTIALLY_REVIVED` if the
   final result strictly improves on the baseline; otherwise `UNRECOVERABLE`.

### Requirement 7: Live progress

1. WHILE a job runs THEN the system SHALL stream stage changes, log lines, attempt results, and a
   heartbeat value (0-100) to the browser via Server-Sent Events.
2. WHEN a client reconnects with the last seen event sequence THEN the system SHALL resume without
   loss or duplication.
3. The system SHALL cap stored log lines per job and truncate overlong lines.

### Requirement 8: Sandbox security

1. All clone/install/build/test commands SHALL run in Docker containers with dropped capabilities,
   no-new-privileges, read-only root filesystem, non-root user, and memory/CPU/PID limits.
2. Build and test SHALL run without network by default.
3. The host SHALL never execute repository code nor run `git` against the cloned working tree.
4. Host file access SHALL reject symlinks, absolute paths, and path traversal.
5. The system SHALL never push to GitHub.

### Requirement 9: Reliability

1. Job state SHALL follow a defined state machine; terminal states are absorbing.
2. IF a worker crashes THEN stale running jobs SHALL be marked `FAILED` with code
   `WORKER_INTERRUPTED` on the next worker start.
3. Network failures during clone or install SHALL be retried once and then reported as
   `NETWORK_ERROR`.
4. Unsupported Node versions SHALL map to the nearest supported major with a warning.
5. Repeated runs on the same commit with the same configuration SHALL try fixes in the same order.

### Requirement 10: Experience

1. The landing page SHALL present a graveyard scene (fog, tombstones, glow) with a prominent URL
   input and a "Resurrect Repository" button, and list recent resurrections as tombstones.
2. The job page SHALL show an ECG monitor that is flat at heartbeat 0 and beats faster and taller as
   heartbeat rises, a health badge, a stage timeline, live terminal logs, and repair attempts.
3. The finished job page SHALL show a dashboard: repaired issues, remaining issues, dependency
   changes, baseline vs final verification, diff viewer, and patch/report downloads.
4. The UI SHALL respect `prefers-reduced-motion`, be keyboard accessible, and work from 360px wide.
