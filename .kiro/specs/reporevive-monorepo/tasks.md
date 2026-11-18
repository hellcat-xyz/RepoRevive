# Tasks: Multi-project repositories

- [x] 1. `core/projects.ts`: skip list, `isOrchestratorRoot`, cap and ordering, `prefixPath`, `aggregateHealth` + unit and property tests _R1, R3, R4_
- [x] 2. `Workspace.openSub` with path and symlink checks + tests _R6_
- [x] 3. `discoverProjects` in `ecosystems/index.ts` + tests (MERN, orchestrator, workspaces, depth, skip list) _R1_
- [x] 4. `MAX_SUBPROJECTS` in `config.ts`, `.env.example`, README _R1.5, R6.3_
- [x] 5. `AttemptRecord.project`, Prisma migration for `RepairAttempt.project`, reporter wiring _R4.2_
- [x] 6. Pipeline: `ProjectRun`, phase-major loops, failure isolation, shared timeout _R2_
- [x] 7. Patch: prefix paths from every project, CI fixes at the root _R3_
- [x] 8. Report and Markdown: `projects[]`, backward-compatible top-level fields _R4.3, R5.1, R5.3_
- [x] 9. UI: project list and attempt filter _R5.2_
- [x] 10. Pipeline tests on `FakeSandbox`: MERN fixture, one repaired and one failing, patch applies, rollback leaves no trace; existing tests unchanged _R7_
- [x] 11. README: describe multi-project support and limits

Status: implemented and covered by unit, property and FakeSandbox pipeline tests (	ests/unit/projects.test.ts, 	ests/unit/discovery.test.ts, 	ests/pipeline/monorepo.test.ts). Not run: the real Docker path and the database migration; run 
px prisma generate (stop the dev server and worker first) and 
pm run db:migrate.
