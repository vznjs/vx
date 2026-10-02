# `src/orchestrator/plugin-host.ts` — capability consultation

## Purpose

Runs the pipeline stages (`config`, `project`, `graph` — each plugin
edits the object in place, in declaration order; `hasHook` is the
zero-cost gate that skips a stage nobody declares), consults the
run-level capabilities (`executor`, `cache`), and runs each plugin's
`teardown()` at the end of the run, crash-isolated and time-bounded.
After the `graph` stage the graph is re-checked the way the builder
checks its own (`checkGraph`: each node under its own id, every dep a
node, no cycle, no two tasks deleting each other's outputs, the addition
marks derived again) and a violation is reported against the last plugin
that ran. Only the first two were checked until item 981: a plugin that
dropped the edge between two overlapping outputs lost one task's files
under a green run, and one that moved a node to another key crashed
the scheduler with a raw TypeError.

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
- `applyConfigHooks` / `applyDiscoverHooks` / `applyProjectHooks` / `applyGraphHooks` /
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
- `executorLabel(executor)` — how a message names a resolved executor:
  `plugin '<name>' (executor '<name>')`, or `executor '<name>'` for the
  local floor. A throwing `accepts` or `demand` is named by it.
- `nameExecutorFailure(executor, err)` — a plugin executor's throw from
  `execute`, its message prefixed `<label> failed in execute:`; the same
  error object, so its class and cause stand. The floor's is untouched
  (C-63).
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
  admits from then on. A refusal while nothing local is running is
  overridden with one warning per plugin: only a completion asks
  again, so it stalled the run for good (item 1023).
- `teardownPlugins(plugins, warn)` — end-of-run, in declaration order:
  each plugin's `teardown()` under try/catch and a time bound
  (`teardownTimeoutMs()`: `VX_TEARDOWN_TIMEOUT_MS`, 3 s by default; a
  call that never settles is warned by name, never awaited past the
  bound). A throw is warned as every stage names one (C-84):
  `plugin '<p>' failed in teardown: <reason>`; the run's verdict stands.
  Runs on every exit of a run once `prepareRun` has called the
  plugins' factories (an early return, a refused setup, a throw before
  or during the schedule) and at the end of a plan, and `prepareRun`
  itself tears down and closes the cache when a stage or refusal after
  the factories throws (item 1029); a plugin whose own
  `setup` threw is left out (item 1021). Telemetry sinks are flushed by
  the telemetry host, not here.

Every export above is named in this section; `tests/module-shape-drift.test.ts`
holds the list to the file.

## Invariants

- What a hook hands back is checked once, at the seam, and refused by
  plugin and hook: a `cache` / `executor` return missing the
  contract's methods, a `key` return that is not a record of strings
  or names a part with a NUL (the fold's delimiter, A-57),
  a `schedule` return that is not a `Map`. A stage's edit is
  re-validated after EACH plugin (the `afterEach` of `applyConfigHooks`
  and `applyProjectHooks`), so the refusal names the plugin whose edit
  broke the config (H-13).
- A capability factory or stage that throws becomes a clean
  `UserError` naming the plugin and the hook: what a plugin does is
  load-bearing, never silently degraded (telemetry sinks are the
  observe-only exception, isolated in `telemetry-host.ts`).
- The finally-path disposers only unsubscribe; teardown is the flush
  point.
