# Design: RepoRevive MVP

## 1. System overview

```
 Browser ──HTTP──▶ Next.js (app router)
   ▲                 │  POST /api/resurrections        create job (zod, rate limit)
   │ SSE             │  GET  /api/resurrections        recent jobs
   │                 │  GET  /api/resurrections/:id    snapshot (job + attempts)
   └─────────────────┤  GET  /api/resurrections/:id/events?after=N   SSE stream
                     │  GET  /api/resurrections/:id/patch            .patch download
                     │  GET  /api/resurrections/:id/report?format=md|json
                     ▼
                PostgreSQL (Prisma) ◀──── Worker process (tsx src/worker/index.ts)
                                            │ claims QUEUED jobs (SKIP LOCKED)
                                            │ runs engine pipeline
                                            ▼
                                     DockerSandbox ──▶ docker run node:<major> ...
                                            (per command, workspace bind-mounted)
```

The web process never runs Docker. The worker is the only component with Docker access.

## 2. Engine ports

```ts
interface Sandbox {
  run(spec: RunSpec, onLine?: (line: string, stream: 'stdout' | 'stderr') => void): Promise<RunResult>;
  ensureImage(image: string): Promise<void>;
}
interface RunSpec {
  image: string;
  command: string[];
  workdir: string /* host path of repo */;
  cacheDir?: string;
  network: 'none' | 'bridge';
  timeoutMs: number;
  env?: Record<string, string>;
  label: string;
}
interface RunResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string; /* tail */
}

interface EventSink {
  emit(e: PipelineEvent): void | Promise<void>;
}
interface PackageRegistry {
  packument(name: string): Promise<Packument | null>;
} // versions + time
interface LlmClient {
  proposeEdits(input: LlmFixRequest): Promise<unknown>;
} // validated later
```

## 3. Ecosystem abstraction

```ts
interface Ecosystem {
  id: string; // 'npm'
  detect(ws: Workspace): Promise<boolean>;
  analyze(ws: Workspace, ctx: AnalyzeContext): Promise<ProjectAnalysis>;
  selectRuntime(ws: Workspace): Promise<RuntimeSelection>; // pure over files
  plan(analysis: ProjectAnalysis): VerificationPlan; // steps + commands
  installInputs(): string[]; // files whose change forces reinstall
  diagnose(step: StepName, result: RunResult, ctx: DiagnoseContext): Issue[];
  strategies: FixStrategy[];
}
interface FixStrategy {
  id: string;
  handles: IssueKind[];
  invasiveness: number; // lower tried first
  propose(issue: Issue, ctx: StrategyContext): Promise<FixProposal[]>;
}
interface FixProposal {
  strategyId;
  title;
  rationale;
  edits: FileEdit[];
  kind: 'runtime' | 'static';
}
type FileEdit = { path: string; content: string | null /* null = delete */ };
```

The pipeline is ecosystem-agnostic: it asks the registry (`ecosystems/index.ts`) for the first
ecosystem whose `detect` succeeds.

## 4. Workspace and patches

`Workspace` wraps the host directory of the clone:

- `read(path)`, `exists(path)`, `list(dir)`: safe-path resolution (reject absolute, `..`, NUL,
  backslash traversal), `lstat` every path component and refuse symlinks, size cap.
- `applyEdits(edits) -> Snapshot`: records prior content (or absence) of every touched file, then
  writes. `rollback(snapshot)` restores byte-identical content and deletes created files.
- `originals`: first-seen content of every file ever touched, used for the final patch.

`createGitPatch(changes: {path, before: string|null, after: string|null}[])` builds a unified diff
with `diff --git a/p b/p`, `new file mode 100644` / `deleted file mode 100644`, `--- /dev/null`,
and `\ No newline at end of file` markers, via `diff.structuredPatch`.

## 5. Pipeline stages

| Stage    | Job status | Health       | Observable outcome                       |
| -------- | ---------- | ------------ | ---------------------------------------- |
| clone    | CLONING    | DEAD         | commit SHA/date, size                    |
| analyze  | ANALYZING  | DIAGNOSING   | `ProjectAnalysis`, static findings       |
| baseline | BASELINE   | DIAGNOSING   | baseline `VerificationResult`, heartbeat |
| diagnose | DIAGNOSING | DIAGNOSING   | issue list                               |
| repair   | REPAIRING  | REPAIRING    | attempts (verified / reverted)           |
| finalize | VERIFYING  | REPAIRING    | final clean `VerificationResult`         |
| report   | REPORTING  | final health | report JSON + patch                      |

Terminal: `COMPLETED` (with health REVIVED/PARTIALLY_REVIVED/UNRECOVERABLE) or `FAILED` (system
error, health UNRECOVERABLE) or `CANCELLED`.

### State machine

```
QUEUED → CLONING → ANALYZING → BASELINE → DIAGNOSING → REPAIRING ⇄ VERIFYING → REPORTING → COMPLETED
any non-terminal → FAILED | CANCELLED ; DIAGNOSING → REPORTING (nothing to fix) ; ANALYZING → REPORTING (not a node project)
```

### Repair loop

```
state = baseline
tried = Set<fingerprint::strategyId>
while attempts < max && time < budget:
  issues = diagnose(state) sorted by step order then severity
  candidate = first (issue, proposal) with untried key, proposals ordered by invasiveness
  if none: break
  snap = ws.applyEdits(proposal.edits)
  next = verify(ws, reinstall = touches(installInputs) || runtime changed)
  if accept(state, next, issue): keep; state = next; record VERIFIED
  else: ws.rollback(snap); record REVERTED (with reason)
static CI fixes: apply, re-parse YAML, re-run rule; keep if rule cleared → VERIFIED_STATIC
final = verify(ws, clean = true)
```

### Acceptance (`decideAcceptance(prev, next, targeted)`)

1. Regression check: any step `passed` in `prev` and not `passed` in `next` → reject.
2. Improvement: some step `failed|timeout|skipped(blocked)` in `prev` is `passed` in `next` → accept.
3. Otherwise, if the targeted fingerprint no longer appears and the first failing step is not
   earlier than before → accept as "progress" (failure moved deeper); else reject.

### Health (`computeHealth(baseline, final)`)

- every applicable step passed → REVIVED
- `score(final) > score(baseline)` → PARTIALLY_REVIVED
- else → UNRECOVERABLE

`score` = sum over steps of weights (install 40, build 30, test 30; skipped-not-applicable counts as
passed; blocked counts as failed), so heartbeat = score.

## 6. Runtime selection

Supported images: `node:{8,10,12,14,16,18,20,22}`. Source priority: `.nvmrc`, `.node-version`,
`package.json#volta.node`, `package.json#engines.node`. For a semver range, choose the highest
supported major satisfying it; for an unsupported exact version, choose the nearest supported major
and warn. Default: 22. Runtime is a pure function of workspace files, so a fix that writes `.nvmrc`
changes the runtime and is undone by rollback.

## 7. npm diagnosis rules and strategies

| Issue kind                   | Detected by                                                                  | Strategy (invasiveness)                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `peer-conflict`              | `ERESOLVE`                                                                   | write `.npmrc` `legacy-peer-deps=true` (1)                                     |
| `lockfile-drift`             | `npm ci` "in sync" message                                                   | regenerate lockfile in sandbox with `--package-lock-only --ignore-scripts` (3) |
| `git-protocol`               | `git://` in manifest/lockfile, or clone failure from `git://github.com`      | rewrite to `git+https://` (1)                                                  |
| `native-build` / `node-sass` | `gyp ERR!`, `node-sass` build failure                                        | replace `node-sass` with era-matched `sass` (4); pin older Node (2)            |
| `engine-mismatch`            | `EBADENGINE`, `Unsupported engine`, `The engine "node" is incompatible`      | pin Node to required major via `.nvmrc` (2)                                    |
| `openssl-legacy`             | `ERR_OSSL_EVP_UNSUPPORTED`                                                   | pin Node 16 via `.nvmrc` (2)                                                   |
| `modern-syntax`              | `SyntaxError: Unexpected token` from `node_modules` on old Node              | pin newer Node (2)                                                             |
| `missing-version`            | `ETARGET`                                                                    | set range to era-matched existing version (3)                                  |
| `unpublished-package`        | `E404`                                                                       | suggestion only                                                                |
| `missing-module`             | `Cannot find module 'x'`, `Can't resolve 'x'` (bare specifier, not declared) | add devDependency with era-matched version (3)                                 |
| `missing-binary`             | `sh: 1: X: not found`                                                        | add devDependency providing the binary (3)                                     |
| `types-incompatible`         | `error TS…` in `node_modules/@types/<pkg>`                                   | pin `@types/<pkg>` to era-matched version (3)                                  |
| `timeout`                    | sandbox timeout                                                              | suggestion only                                                                |
| `unknown`                    | non-zero exit with no rule                                                   | LLM strategy if configured, else suggestion                                    |

Era-matched version: highest version in the packument whose publish time ≤ repository's last
commit date (optionally constrained to a range); falls back to `latest` when none exists.

## 8. CI rules (GitHub Actions, static)

- `actions/checkout|setup-node|cache|upload-artifact|download-artifact@v1..v3` → `@v4`.
- `runs-on: ubuntu-16.04|18.04|20.04` → `ubuntu-latest`; `macos-10.15|11|12` → `macos-latest`;
  `windows-2016|2019` → `windows-latest`.
- `node-version` scalars/flow lists with EOL majors (< 18) → the verified runtime major (or 20).
  Edits are line-level replacements to keep diffs minimal. Verified by YAML parse + rule re-check.

## 9. Data model (Prisma)

- `Resurrection`: id, repoUrl, owner, name, status, health, heartbeat, currentStage, commitSha,
  commitDate, runtime, analysis/baseline/final/report (Json), patch (Text), errorCode,
  errorMessage, eventSeq, lockedBy, lockedAt, timestamps.
- `RepairAttempt`: id, resurrectionId, seq, issueKind, fingerprint, strategyId, title, rationale,
  status (VERIFIED | VERIFIED_STATIC | REVERTED | SUGGESTED | ERROR), reason, files, diff,
  verification (Json), durationMs.
- `JobEvent`: id, resurrectionId, seq (unique per job), type, level, message, data (Json), ts.

## 10. Events and SSE

`PipelineEvent = stage | status | log | attempt | heartbeat | issue | done`. The DB sink assigns
`seq` in-process (single writer per job), batches log lines every 250ms, and truncates lines to
2,000 chars and jobs to 20,000 log events. The SSE route polls `JobEvent where seq > cursor`
every 750ms, sends `id: <seq>` so `EventSource` reconnects with `Last-Event-ID`, and closes after
emitting `done`.

## 11. Sandbox implementation

`docker run --rm --name rr-<job>-<n> --label reporevive.job=<id> --user <uid>:<gid>
 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,size=1g
 --memory 2g --cpus 2 --pids-limit 512 --network <none|bridge>
 -v <repo>:/workspace -v <cache>:/npm-cache -w /workspace
 -e HOME=/tmp -e CI=true -e npm_config_cache=/npm-cache ... node:<major> sh -lc '<cmd>'`

Commands are fixed templates built by the engine (no user input). Timeout: `docker kill` by name.
Workspace cleanup runs `rm -rf` inside a container (files may be owned by the sandbox uid).

## 12. LLM strategy (optional)

Enabled when `LLM_API_KEY` is set. Sends the failing step, the last 150 log lines, `package.json`,
and up to 4 referenced source files (≤ 12 KB each) to an OpenAI-compatible
`/chat/completions` endpoint, requesting JSON `{edits:[{path, search, replace}], rationale}`.
Output is zod-validated, paths sanitized, each `search` must match exactly once, total edit ≤ 20 KB.
It then flows through normal verification.

## 13. Correctness properties (fast-check)

- P1 Rollback: ∀ initial files F, edits E: rollback(apply(F, E)) == F (bytes, existence).
- P2 Patch: ∀ before/after file sets: applyPatch(before, createGitPatch(before, after)) == after.
- P3 State: ∀ transition sequences, accepted transitions ⊆ allowed edges; terminal absorbing.
- P4 Acceptance: accept(prev, next) ⇒ ∀ step passed in prev: passed in next.
- P5 Preservation: ∀ scripted worlds, final workspace == originals + accepted edits, in order; no
  reverted edit content survives unless re-applied by a later accepted fix.
- P6 Health monotonicity: health(baseline, final) is REVIVED ⇔ all steps pass in final.
- P7 URL parsing: ∀ valid owner/repo, parse(format(owner, repo, decorations)) == (owner, repo).

## 14. Error handling

`ResurrectionError(code, message)` codes: `INVALID_URL`, `REPO_NOT_FOUND_OR_PRIVATE`,
`REPO_TOO_LARGE`, `CLONE_FAILED`, `NETWORK_ERROR`, `NOT_A_NODE_PROJECT`, `DOCKER_UNAVAILABLE`,
`JOB_TIMEOUT`, `WORKER_INTERRUPTED`, `INTERNAL`. Strategy exceptions are recorded as attempt `ERROR`
and never abort the job.
