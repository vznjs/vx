# `src/orchestrator/plugin-host.ts` — capability consultation

## Purpose

Runs the pipeline stages (`config`, `project`, `graph` — each plugin
edits the object in place, in declaration order; `hasHook` is the
zero-cost gate that skips a stage nobody declares), consults the
run-level capabilities (`executor`, `cache`), and runs each plugin's
`teardown()` at the end of the run, crash-isolated and time-bounded.
After the `graph` stage the graph is re-checked (every dep names a node,
no cycle) and a violation is reported against the last plugin that ran.

Every capability is resolved inside `prepareRun`/`run()` from the declared
list (`prepared.plugins`). (A whole-run `backend` capability was resolved
by the CLI layer before `run()` started, until that seam was removed in
2026-08 — it moved the scheduler server-side, which is exactly what core
does not do. `executor` replaced it at the per-task grain.)
Nothing is appended — no executor or no cache is a named error
(`MISSING_PLUGIN_HINT`).

## Public surface

- `resolveExecutors(plugins, ctx)` → `TaskExecutor[]` (ordered; a
  throwing factory aborts; an empty result is a named error).
- `resolveCache(plugins, ctx)` → `CacheLayer` (one layer as is; two or
  more chained in order — `ChainedCache`; a layer wrapping the local
  handle subsumes the bare local layer; none is a named error).
- `applyConfigHooks` / `applyProjectHooks` / `applyGraphHooks` /
  `applyKeyHooks` / `applyScheduleHooks` — the pipeline stages, run in
  declaration order only when some plugin declares them (`hasHook`).
- `resolveExecutors(plugins, ctx)` — the executors in order; the first
  to accept a task runs it.
- `teardownPlugins(plugins, warn)` — end-of-run: each plugin's
  `teardown()` under try/catch and a time bound; errors warn, never
  throw. Telemetry sinks are flushed by the telemetry host, not here.

## Invariants

- Sink init failures are isolated per plugin (warn + skip).
- Dispose only unsubscribes; teardown is the flush point.
