# Design: Multi-project repositories

## Approach

Treat a sub-project as its own `Workspace` rooted at `<repo>/<folder>`. Ecosystems, `Verifier`,
strategies and the sandbox already take a workspace root and use root-relative paths, so none of
them change. The pipeline gains a list of project runs and loops over them per phase.

```
clone -> analyze (discover) -> baseline[all] -> diagnose[all] -> repair[all] -> finalize[all] -> report
```

Phase-major order keeps the existing state machine (`BASELINE` is only reachable from `ANALYZING`)
and gives the UI progress bar the same meaning as today.

## New and changed modules

| Module                                     | Change                                                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/core/projects.ts` (new)            | Pure helpers: `isOrchestratorRoot`, `rankProjects`/cap, `prefixPath`, `aggregateHealth`, skip list.                                                                                                                                            |
| `engine/core/workspace.ts`                 | `Workspace.openSub(parent, folder)`: validates the folder, rejects symlinks, returns a workspace rooted there. Adds `prefix` so `changes()` can be re-based by the caller.                                                                     |
| `engine/ecosystems/index.ts`               | `discoverProjects(ws, ecosystems, opts)`: walks depth <= 2 through `Workspace.list`, calls `detection()` per folder.                                                                                                                           |
| `engine/pipeline.ts`                       | `ProjectRun` state (ws, eco, analysis, verifier, baseline, state, final, error). Phases iterate runs. `repairLoop` and `tryFix` take a run instead of loose arguments; logic is unchanged. Root-only jobs build a single run with folder `""`. |
| `engine/report.ts`                         | `projects[]` in the report and Markdown; top-level fields keep the first (or only) project's values for old readers.                                                                                                                           |
| `engine/core/types.ts`                     | `AttemptRecord.project?: string`.                                                                                                                                                                                                              |
| `prisma/schema.prisma` + migration         | `RepairAttempt.project String?` (new migration, none edited).                                                                                                                                                                                  |
| `server/config.ts`, `.env.example`, README | `MAX_SUBPROJECTS`.                                                                                                                                                                                                                             |
| UI                                         | Project list and attempt filter on the job page; unchanged for single projects.                                                                                                                                                                |

## Discovery rules

1. Run root detection as today.
2. `selected === null` -> search sub-folders.
3. `selected` is npm and `isOrchestratorRoot(manifest, files)` -> search sub-folders; if none found, fall back to the root project.
4. Otherwise one project, plus a warning if the search (still run, read-only) finds sub-projects.
5. Each candidate folder is opened with `Workspace.openSub`; detection failures in one folder are logged and skipped.

`isOrchestratorRoot` is a pure function over parsed `package.json` and the root file list, so it gets a property test.

## Paths and patch

Each project's `Workspace` tracks root-relative paths. At report time the pipeline collects
`run.ws.changes()` for every run and rewrites each path with `prefixPath(folder, path)`, then calls
`createGitPatch` once. Attempt `files` and `diff` headers are prefixed the same way before they are
saved. The static CI step uses the repository-root workspace.

## Sandbox

`RunSpec.workdir` is the sub-project host path, mounted at `/workspace` as before. No change to
`docker-sandbox.ts`. Cost: sub-projects cannot see sibling folders. Accepted and documented (see
requirements, scope).

## Failure isolation

`runProject(run, phase)` wraps each phase in try/catch. `CANCELLED` and `DOCKER_UNAVAILABLE`
rethrow. Anything else sets `run.error`, logs it with the project folder, and the loop continues.
A project with an error is excluded from `REVIVED` and reported with its error.

## Health

```
aggregateHealth(results): results = [{ health, ran }]
  all ran and all REVIVED          -> REVIVED
  any REVIVED / PARTIALLY_REVIVED  -> PARTIALLY_REVIVED
  otherwise                        -> UNRECOVERABLE
```

## Decisions to confirm

- Per-project repair budget (`MAX_REPAIR_ATTEMPTS` each) instead of one shared budget. Simpler and fairer; the shared job timeout still bounds total time.
- Mount only the sub-folder instead of the whole repo with a `cwd`. Safer and needs no sandbox change; loses `../shared` references.
- New nullable `RepairAttempt.project` column instead of encoding the folder in `title`.
