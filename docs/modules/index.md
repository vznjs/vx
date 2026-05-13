# `src/index.ts` — public package surface

## Purpose

The single entry point for `import x from '@vzn/vx'`. Everything in
this file is the public API; everything else under `src/` is
internal.

## Public surface

```ts
export const VERSION: string // current package version

// Schema types — used by user vx.config.* and preset packages.
export type {
  WorkspaceConfig,
  ProjectConfig,
  TaskConfig,
  ExecConfig,
  ExecEnv,
  PersistentConfig,
  CacheConfig,
  CacheInputs,
  CacheOutputs,
} from './config.js'

// Schema helpers — identity functions for type inference.
export { defineProject, defineWorkspace } from './config.js'

// Programmatic engine entry points.
export { run } from './orchestrator.js'
export type { Logger, RunOptions, RunSummary } from './orchestrator.js'
export type { TaskOutcome, TaskStatus } from './graph/scheduler.js'
export type { TaskNode } from './graph/task-graph.js'
```

## Conventions

- **Types are exported with `export type`** so a downstream
  TypeScript project can import them without paying any runtime
  cost.
- **Runtime exports are minimized** — `defineProject` /
  `defineWorkspace` (identity helpers), `run` (the orchestrator
  entry), `VERSION` (string). Everything else is a type.
- **`planRun` is intentionally not re-exported here yet.** It's an
  internal CLI helper for `--dry` / `--graph`; we'll promote it when
  there's a real embedding use case.
- **`UserError` is not re-exported.** Programmatic consumers can
  import it from `@vzn/vx/util/errors` if they need it, but it isn't
  part of the public package surface.

## Versioning

`VERSION` is a string constant. Pre-alpha — currently `'0.0.0'`. Bump
on every release via the release workflow (`gh release create v0.x.y`
triggers `.github/workflows/release.yml` which builds the cross-
target binaries and attaches them).

## Tests

`tests/config.test.ts` imports the helpers; `tests/orchestrator.test.ts`
imports `run`. No dedicated test for `index.ts` itself — it's
re-exports.
