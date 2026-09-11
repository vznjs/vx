# Plugins — core ships none

## Purpose

Core applies NO plugin on its own and ships none. Running a command
here and caching it in `.vx/cache` are not plugins but core's FLOOR:
`resolveExecutors` appends `localExecutor()` (`src/exec/local-executor.ts`)
to the tail of every executor list and `resolveCache` appends the host's
local `Cache` to the tail of every chain (`src/orchestrator/plugin-host.ts`).
A workspace with no `vx.workspace.ts` therefore runs and caches, and a
plugin executor whose `accepts()` declines hands the task back to this
machine.

Every plugin is a package a workspace declares:

```ts
// vx.workspace.ts
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default { plugins: [scheduleHistoryPlugin()] }
```

`src/plugins/` no longer exists. Its last occupant, the history-based
scheduler, moved to `@vzn/vx-schedule-history` on 2026-09-10; it had been
core's opt-in `predictive` mode until 2026-09-02 and a subpath export of
core until the move. What core keeps is what a plugin needs from the
façade: `LocalHistoryProvider` and the `HistoryTable` types for a
`schedule` plugin, `LayeredCache` and `RemoteCacheLayer` for a cache
plugin, the `TaskExecutor` contract for an executor.

## Isolation contract

- A plugin package imports core ONLY through the bare public specifier
  `'@vzn/vx'` (resolved inside this repo by the workspace link), never a
  `packages/*` path, never a sibling `@vzn/vx-*` — pinned by
  `tests/package-boundaries.unsafe.test.ts`.
- Core never imports a sibling package or any `packages/*` path: the
  dependency direction is plugin → core, never the reverse (same pin).
- `src/plugins/` stays absent: `tests/module-boundaries.test.ts` and
  `tests/package-boundaries.unsafe.test.ts` fail the day a directory
  appears there, so a new plugin starts life as a package.
- Every package carries a root `index.ts` shim for Bun's compiled binary,
  which resolves packages by directory convention and ignores `exports`
  (`tests/package-entry-shims.unsafe.test.ts`).

## The packages

| Package                    | Seam                 | What it does                                                                                                             |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@vzn/vx-schedule-history` | `schedule`           | order ready tasks by the critical path learned from run history                                                          |
| `@vzn/vx-reapi`            | `executor`, `cache`  | Bazel REAPI: remote execution and remote cache                                                                           |
| `@vzn/vx-otel`             | `telemetry`          | OpenTelemetry export, no SDK dependency                                                                                  |
| `@vzn/vx-github`           | `telemetry`          | GitHub Actions job summary and Checks API                                                                                |
| `@vzn/vx-mcp`              | `commands`           | `vx mcp`, an MCP server for AI agents                                                                                    |
| `@vzn/vx-migrate`          | `project`, `cache`   | `turbo()`: a Turbo repo under vx with nothing written; `turboCache()` / `nxCache()`: the Turbo and Nx remote-cache wires |
| `@vzn/vx-lockfile`         | `fingerprint`, `key` | `pnpm()` `bun()` `npm()` `yarn()`: the lockfile keyed per project — one install re-keys only the projects it reaches     |

## Tests

`tests/local-fallbacks.test.ts` (the floor: a workspace with no workspace
file runs and caches; a declining executor falls back), the `NO PLUGINS` /
`CONTROL` e2e pins in `tests/plugin-capabilities.test.ts`, and each
package's own suite (CI's plugin-packages job).
