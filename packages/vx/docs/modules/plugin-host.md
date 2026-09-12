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
Core's floor is appended: `resolveExecutors` puts `localExecutor()` at
the tail of the list and `resolveCache` puts the host's local `Cache` at
the tail of the chain (dropped again when a declared layer already wraps
it), so a workspace that declares nothing runs and caches here.

## Public surface

- `resolveExecutors(plugins, ctx)` → `TaskExecutor[]` (ordered, the local
  executor last; a throwing factory aborts).
- `resolveCache(plugins, ctx, opts?)` → `CacheLayer` (one layer as is; two or
  more chained in order — `ChainedCache`; a layer wrapping the local
  handle subsumes the bare local layer; none is a named error).
- `opts.workspaceFile: false` (host-only; plugins never see it) makes
  either "no plugin" error lead with `vx init`, for a root with no
  `vx.workspace.*` at all — a file that declares nothing gets the plain
  error, since `init` would refuse to overwrite it.
- `applyConfigHooks` / `applyProjectHooks` / `applyGraphHooks` /
  `applyKeyHooks` / `applyScheduleHooks` — the pipeline stages, run in
  declaration order only when some plugin declares them (`hasHook`).
- `buildAdmission(plugins, nodes, concurrency, warn)` → the scheduler's
  `admit(id, running)` predicate, or undefined when no plugin declares
  `admit` (the scheduler then tracks nothing). Every declaring plugin is
  asked with the running tasks' nodes and the worker count, all must
  admit; a throw is warned once, naming the plugin, and that plugin
  admits from then on.
- `resolveExecutors(plugins, ctx, opts?)` — the executors in order; the first
  to accept a task runs it.
- `teardownPlugins(plugins, warn)` — end-of-run: each plugin's
  `teardown()` under try/catch and a time bound; errors warn, never
  throw. Telemetry sinks are flushed by the telemetry host, not here.

## Invariants

- What a hook hands back is checked once, at the seam, and refused by
  plugin and hook: a `cache` / `executor` return missing the
  contract's methods, a `key` return that is not a record of strings,
  a `schedule` return that is not a `Map`. A stage's edit is
  re-validated after EACH plugin (`applyProjectHooks`' `afterEach`), so
  the refusal names the plugin whose edit broke the task.
- Sink init failures are isolated per plugin (warn + skip); a sink with
  no handler at all is one of them.
- Dispose only unsubscribes; teardown is the flush point.
