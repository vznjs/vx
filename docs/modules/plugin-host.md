# `src/orchestrator/plugin-host.ts` — capability consultation

## Purpose

Consults the plugins' run-level capabilities in declaration order
(`executor`, `cache`) and wires each plugin's `eventSink`
capability onto the run bus via `wireForwarder`, so sinks receive the
serializable `WireEvent` stream.

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
- `resolveBackend(plugins, ctx, fallback)` → `RunBackend` (first wins;
  the caller's fallback otherwise).
- `subscribeEventSinks(plugins, bus, ctx)` → `SubscribedEventSinks`
  (the live sinks + a disposer).
- `teardownPlugins(plugins, sinks, warn)` — end-of-run: each sink's
  `flush()` then each plugin's `teardown()`, each under try/catch and a
  time bound; errors warn, never throw.

## Invariants

- Sink init failures are isolated per plugin (warn + skip).
- Dispose only unsubscribes; teardown is the flush point.
