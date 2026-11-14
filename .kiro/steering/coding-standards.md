---
inclusion: fileMatch
fileMatchPattern: '**/*.{ts,tsx}'
---

# Coding Standards

- TypeScript `strict` mode. No `any` except at validated trust boundaries; prefer `unknown` + zod.
- Validate all external input (HTTP bodies, query params, env, LLM output, registry JSON) with zod
  or explicit guards before use.
- Pure functions for decisions (verification acceptance, health, runtime selection, diagnosis
  parsing). Side effects live at the edges (sandbox, db, fs).
- Errors: throw typed errors (`ResurrectionError` with a `code`) from the engine; the pipeline
  converts them into events and terminal states. Never swallow errors silently; log them as events.
- Naming: `camelCase` functions/vars, `PascalCase` types/components, `kebab-case` file names except
  React components (`PascalCase.tsx`).
- Keep files focused (< ~400 lines). Extract helpers rather than nesting deeply.
- No new runtime dependency without a clear need; prefer the platform and existing libraries
  (`semver`, `diff`, `yaml`, `zod`).
- Formatting is Prettier (see `.prettierrc`), linting is ESLint flat config. Both must pass.
