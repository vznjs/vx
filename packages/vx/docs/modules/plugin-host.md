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

- `hasHook(plugins, hook)` — the zero-cost gate: does any plugin
  declare the stage.
- `applyConfigHooks` / `applyProjectHooks` / `applyGraphHooks` /
  `applyKeyHooks` / `applyScheduleHooks` — the pipeline stages, run in
  declaration order only when some plugin declares them.
- `fingerprintClaims(plugins)` → claimed file → its one claimant (the
  schema refused a second, so this only indexes);
  `claimedAffected(plugin, change, ctx)` asks the claimant which
  projects a change to its file reaches — `undefined` is every project,
  and a non-iterable answer is refused by name.
- `resolveExecutors(plugins, ctx)` → `TaskExecutor[]` (ordered, the
  local executor last; the first to accept a task runs it; a throwing
  factory aborts).
- `resolveCache(plugins, ctx)` → `CacheLayer` (one layer as is; two or
  more chained in order — `ChainedCache`; a layer wrapping the local
  handle subsumes the bare local layer; none declared leaves the local
  store unwrapped). `CACHE_LAYER_METHODS` is what a returned layer must
  carry.
- `buildAdmission(plugins, nodes, concurrency, warn)` → the scheduler's
  `admit(id, running)` predicate, or undefined when no plugin declares
  `admit` (the scheduler then tracks nothing). Every declaring plugin is
  asked with the running tasks' nodes and the worker count, all must
  admit; a throw is warned once, naming the plugin, and that plugin
  admits from then on.
- `teardownPlugins(plugins, warn)` — end-of-run, in declaration order:
  each plugin's `teardown()` under try/catch and a time bound
  (`teardownTimeoutMs()`: `VX_TEARDOWN_TIMEOUT_MS`, 3 s by default; a
  call that never settles is warned by name, never awaited past the
  bound). Runs on the normal completion path only. Telemetry sinks are
  flushed by the telemetry host, not here.

Every export above is named in this section; `tests/module-shape-drift.test.ts`
holds the list to the file.

## Invariants

- What a hook hands back is checked once, at the seam, and refused by
  plugin and hook: a `cache` / `executor` return missing the
  contract's methods, a `key` return that is not a record of strings,
  a `schedule` return that is not a `Map`. A stage's edit is
  re-validated after EACH plugin (`applyProjectHooks`' `afterEach`), so
  the refusal names the plugin whose edit broke the task.
- A capability factory or stage that throws becomes a clean
  `UserError` naming the plugin and the hook: what a plugin does is
  load-bearing, never silently degraded (telemetry sinks are the
  observe-only exception, isolated in `telemetry-host.ts`).
- The finally-path disposers only unsubscribe; teardown is the flush
  point.
