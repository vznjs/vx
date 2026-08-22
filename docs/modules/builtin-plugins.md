# `src/orchestrator/builtin-plugins.ts` — core's behaviour as plugins

## Purpose

There is no hidden fallback for running a task or holding the cache.
`vx/local-executor` (in-process spawn) and `vx/local-cache` (the `.vx/cache`
handle) are ordinary `VxPlugin`s, appended to the workspace's declared list
by `withBuiltins()` unless the workspace declares them itself — in which
case their declared position is their precedence.

## Public surface

- `localExecutorPlugin()`, `localCachePlugin()`, `builtinPlugins()`
- `withBuiltins(declared)` → declared plugins, then each built-in not
  already present by name.
- `LOCAL_EXECUTOR_PLUGIN`, `LOCAL_CACHE_PLUGIN` (the names).

## Using them from `vx.workspace.ts`

    // default: [mine(), vx/local-executor, vx/local-cache]
    export default defineWorkspace({ plugins: [mine()] })

    // pin local execution AHEAD of a remote executor for this workspace
    export default defineWorkspace({ plugins: [localExecutorPlugin(), remote()] })

## Invariants

- A workspace with no `plugins` resolves to exactly the two built-ins and
  runs byte-identically to pre-seam vx (pinned by the orchestrator suites).
- The built-ins contribute no `setup`/`eventSink`/`telemetry`/`teardown`,
  so every gate that counts those stays zero-cost.

## Tests

`tests/builtin-plugins.test.ts`; `resolveCache: the built-in list ...` in
`tests/plugin-capabilities.test.ts`.
