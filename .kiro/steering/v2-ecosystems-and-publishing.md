# V2: Ecosystems and Publishing Conventions

## Ecosystem extension rules

- A new ecosystem lives in `src/engine/ecosystems/<id>/` and is registered in `ecosystems/index.ts`.
  It is advertised in the UI (`SUPPORTED_ECOSYSTEMS`) only after detector, runtime, plan, diagnoser,
  strategies, fixtures and tests exist.
- Strategies belong to exactly one ecosystem. Never share a strategy list across ecosystems.
- Images come only from `engine/core/images.ts`. Never build an image string from repo content or LLM output.
- Plans use argv arrays validated by `assertSafeCommand`. `sh -c` is allowed only with a fixed template
  plus values that passed an allow-list regex.
- "No tests" is `skipReason: 'no-test-suite'`, never `passed`. Coverage is reported separately.

## Publishing rules

- Publishing code lives in `src/engine/publish` and only talks to the `GitHubApi` port.
- Tokens: decrypted only inside the publish call, never logged, never put in events, reports or errors.
- Every publish path must pass `evaluatePublishPolicy` first. No mode bypasses it.
- A publication row is unique per job. Remote objects are reconciled before they are created.
- Nothing merges, approves, force-pushes or touches the default branch. There is no such code path.
- External-write tests are opt-in (`REPOREVIVE_GITHUB_LIVE_TESTS=1`) and target a repo named in env.

## Testing standards

- Every new decision function has a property test. Fakes for GitHub and sandbox; no real network by default.
