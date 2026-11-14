---
inclusion: always
---

# Product: RepoRevive

RepoRevive resurrects abandoned or broken public Node.js/npm GitHub repositories. A user pastes a
GitHub URL; the system clones it into a sandbox, records baseline failures, applies targeted fixes one
at a time, keeps only fixes that verification supports, and produces a report plus a Git-compatible
`.patch` file.

## Non-negotiables

- Untrusted repository code (npm scripts, build, tests, git operations) runs only inside isolated,
  resource-limited Docker containers. Never on the application host.
- Nothing is ever pushed to GitHub. There is no push code path. Any future push feature requires
  explicit per-action user authorization and a separate spec.
- Every change shown to the user is labelled as one of: verified (runtime), verified (static),
  reverted, or suggested (unverified). Users must never confuse a suggestion with a verified fix.
- Minimal change principle: prefer config fixes over dependency changes, and pinning versions from
  the repository's own era over upgrading to latest.
- Private repositories are out of scope for the MVP and must fail fast with a clear message.

## Vocabulary (use these terms consistently)

- **Resurrection**: one end-to-end job for one repository at one commit.
- **Stage**: a pipeline phase (clone, analyze, baseline, diagnose, repair, finalize, report).
- **Issue**: a detected problem with a stable `fingerprint`.
- **Fix / Repair attempt**: a set of file edits produced by a strategy for an issue.
- **Verification**: running install/build/test in the sandbox and comparing against the previous result.
- **Health**: Dead, Diagnosing, Repairing, Partially Revived, Revived, Unrecoverable.
