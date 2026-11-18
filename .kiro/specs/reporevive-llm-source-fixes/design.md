# Design: AI-assisted source fixes

- `engine/llm/integrity.ts`: pure `checkEditIntegrity(path, before, after)` returning a violation message or null.
  Called by `materializeEdits` on every resulting file.
- `engine/llm/context.ts`: `buildLlmContext(ctx, issue, log)` returns `{ files, tree }`. Pure helpers
  `referencedFiles` (moved here, broader extensions) and `localImports(path, content)`.
- `engine/llm/llm-strategy.ts`: uses the context builder, enforces `ctx.llmMaxPerIssue`, orders prior attempts
  (same issue first), schema allows 10 edits.
- `engine/llm/openai-client.ts`: prompt for multi-file source edits, repository tree section, outcome detail for
  reverted attempts, code-fence tolerant JSON parsing, one retry on 429/5xx.
- `pipeline.ts`: `StrategyContext.attempts` carries `fingerprint`, `strategyId`, `detail`; reverted attempts store the
  failing step tail; the repair loop skips a proposal whose edits hash was already tried for the issue.
- `publish/body.ts`: "AI-assisted changes" section.
- UI: `AttemptCard` shows an AI chip for `strategyId === 'llm-source-fix'`.

Security is unchanged: LLM output is untrusted, edits stay inside the workspace, nothing from the model runs on the
host, and verification happens in the sandbox.
