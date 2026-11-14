# Tasks: Repair engine upgrade

- [x] 1. Investigate the failure path and confirm root cause — _R1, R3_
- [x] 2. Types: new issue kinds, `IssueDiagnostic`, explanations — _R1.3, R1.4_
- [x] 3. Lifecycle parsing helpers + diagnoser rules + fixture log — _R1_
- [x] 4. `UpstreamResolver` port and GitHub HTTP implementation — _R2, R5_
- [x] 5. `upstream-ref-pin` strategy — _R2_
- [x] 6. Pipeline: wire resolver, log consulted strategies, record no-proposal suggestions — _R3_
- [x] 7. LLM strategy: handle new kinds and include the failing script file — _R2 (complex cases)_
- [x] 8. Worker wiring and `GITHUB_TOKEN` use — _R5.3_
- [x] 9. Terminal source colours — _R4_
- [x] 10. Tests: unit (diagnose, strategy), OrexisAI regression through the pipeline, property tests — _all_
- [x] 11. Steering (`repair-strategies.md`) and hooks — _Kiro_
- [x] 12. README update

## Status

Implemented and verified with unit, property, and pipeline tests (FakeSandbox) plus a manual end-to-end run of the real OrexisAI commit through the real Docker sandbox and GitHub API (health REVIVED, one verified fix). Not covered: the opt-in Docker test suite (
pm run test:docker) and the database-backed worker/UI path were not run in this session.
