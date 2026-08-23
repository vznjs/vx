# `src/plugins/` — core-provided plugins, each isolated

## Purpose

Core applies NO plugin on its own — not even its executor or its cache. Each
directory under `src/plugins/<name>/` is a complete plugin a workspace
declares like any third-party one:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
```

`vx migrate` emits this file when none exists. A workspace that declares no
executor or no cache provider fails before any task runs; the error
(`MISSING_PLUGIN_HINT`, `src/orchestrator/missing-plugin.ts`) shows these
lines.

## Isolation contract

- A plugin imports core ONLY through the bare public specifier `'@vzn/vx'`
  (resolved inside this repo by the `node_modules/@vzn/vx -> ../..`
  self-link, exactly as `packages/*` do) and never reaches relatively outside
  its own directory.
- `src/index.ts` does not re-export them; they are published as subpath
  exports (`package.json` `exports`: `./plugins/<name>`).
- Consequence: any directory can be moved into its own package with zero
  edits. Pinned by `tests/module-boundaries.test.ts` (`plugins` module: no
  relative cross-module import) and `tests/package-boundaries.test.ts`
  (Rule 4: each plugin imports from `'@vzn/vx'` and nothing else non-relative).

## `local-executor` — `@vzn/vx/plugins/local-executor`

`localExecutorPlugin()` → `vx/local-executor`. In-process spawn: the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly,
behind the `TaskExecutor` contract (`docs/modules/executor.md`). Accepts
every task, and declares neither `remote` nor `capacity` — its tasks run on
the local worker pool and honour `exec.resources`. `localExecutor()` is exported too, for plugins that wrap local
execution (set up cgroups, then delegate).

## `local-cache` — `@vzn/vx/plugins/local-cache`

`localCachePlugin()` → `vx/local-cache`. Hands back the `.vx/cache` handle
the host opened (`ctx.localCache`: the run index + the local artifact
store). Declared like any other cache layer; put a remote layer BEFORE it to
look there first (`docs/modules/chained-cache.md`).

## Tests

`tests/local-plugins.test.ts`; the `NO DEFAULTS` / `CONTROL` e2e pins in
`tests/plugin-capabilities.test.ts`; `tests/helpers/local-workspace.ts` is
the one place fixtures get the declaration.
