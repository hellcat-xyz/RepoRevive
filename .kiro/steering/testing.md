---
inclusion: fileMatch
fileMatchPattern: '{src/engine/**,tests/**,src/sandbox/**,src/server/**}'
---

# Testing Rules

- Framework: Vitest. Property-based tests: fast-check. Run with `npm test`.
- Every engine decision function has unit tests; every invariant below has a property test:
  - Rollback correctness: apply(edits) then rollback restores byte-identical files.
  - Patch consistency: applying the generated patch to the original files yields the final files,
    and `git apply --check` accepts it (integration test with generated, trusted content).
  - State transitions: only allowed transitions succeed; terminal states are absorbing.
  - Verification: an accepted fix never regresses a previously passing step.
  - Preservation: the final workspace contains every accepted fix and no reverted fix.
- The pipeline is tested end-to-end against `FakeSandbox` (a scripted world model) so tests never
  need Docker or network. Real Docker tests are opt-in via `REPOREVIVE_DOCKER_TESTS=1`.
- Diagnosis parsers are tested against realistic npm/node log excerpts in `tests/fixtures/`.
- Tests must be deterministic: no real time, network, or randomness without a seed.
