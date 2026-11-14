---
inclusion: always
---

# Architecture Rules

## Layout

```
src/
  app/            Next.js App Router (UI pages + API route handlers). No engine logic here.
  components/     React UI components (client components marked "use client").
  lib/            Shared pure helpers usable by UI and server (github URL parsing, health labels).
  engine/         The resurrection pipeline. Pure TypeScript, framework-free.
    core/         Ecosystem-agnostic types, state machine, verification decisions, patch, workspace.
    ecosystems/   One folder per ecosystem (npm today). Implements the `Ecosystem` interface.
    ci/           GitHub Actions analysis and static fixes (ecosystem-agnostic).
    llm/          Optional LLM-backed fix strategy (OpenAI-compatible API).
    pipeline.ts   Orchestrates stages; depends only on ports (interfaces).
  sandbox/        Docker sandbox implementation of the `Sandbox` port.
  server/         Database access (Prisma), job queue, event sink, config.
  worker/         Long-running worker process entry point.
prisma/           Schema and migrations.
tests/            Vitest unit, property (fast-check), and integration tests.
```

## Dependency direction

`app -> server -> engine/core`, `worker -> server, sandbox, engine`. The engine never imports
Next.js, Prisma, or Docker code; it receives `Sandbox`, `EventSink`, `PackageRegistry`, and
`LlmClient` ports. This keeps the engine fully testable with fakes.

## Extensibility

New languages/package managers are added as a new `Ecosystem` implementation under
`src/engine/ecosystems/<name>/` and registered in `src/engine/ecosystems/index.ts`. Do not add
`if (npm)` branches to the pipeline; put ecosystem specifics behind the interface.

## Jobs and live updates

- Jobs are rows in PostgreSQL. Workers claim them with `FOR UPDATE SKIP LOCKED`.
- Progress is persisted as ordered `JobEvent` rows (monotonic `seq` per job). The SSE endpoint
  streams events after a client-supplied cursor, so reconnects never lose or duplicate events.
- Status changes go through the state machine in `engine/core/state.ts`. Never write a status
  string directly.
