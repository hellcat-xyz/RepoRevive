---
inclusion: always
---

# Security Rules

## Sandbox (every container that touches repository content)

- `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root filesystem,
  `--pids-limit`, `--memory`, `--cpus`, non-root `--user`, tmpfs for `/tmp`.
- Network: enabled only for clone and dependency install. Build and test run with `--network none`
  unless an operator explicitly opts in via config.
- Every command has a timeout; on timeout the container is killed (`docker kill`) and removed.
- Containers are labelled `reporevive.job=<id>` so orphans can be reaped.
- The Docker socket is never mounted into sandbox containers.

## Host-side handling of untrusted files

- The host never executes repository content and never runs `git` against the cloned repository
  (a sandboxed script could plant `core.fsmonitor` or hooks). Patches are generated in TypeScript.
- All host file access goes through `Workspace`, which rejects absolute paths, `..` traversal,
  and symlinks anywhere along the path, and caps file sizes.

## Input and output

- GitHub URLs are parsed with a strict allow-list (`https://github.com/<owner>/<repo>`); anything
  else is rejected before any network or process call.
- Values passed to `docker` are passed as argv arrays via `spawn` (never a shell string).
- Secrets (`DATABASE_URL`, `LLM_API_KEY`, `GITHUB_TOKEN`) come from env only, never logged, never
  sent to sandboxes. Sandbox env is an explicit allow-list.
- LLM output is untrusted: validate schema, restrict edit paths to the workspace, forbid
  `node_modules`/`.git`, cap edit size, and verify like any other fix.
- API routes are rate-limited per client IP and validate bodies with zod.
- No push to GitHub. No credentials are given to cloned code.
