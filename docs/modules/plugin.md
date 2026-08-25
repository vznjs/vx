# `src/orchestrator/plugin.ts` — the VxPlugin interface + installer

## Purpose

The integration seam. A plugin declares a `name` plus at least one
capability; `defineWorkspace({ plugins: [...] })` activates it. Core
consults capabilities at fixed points and otherwise ignores plugins —
behavior lives in the plugin package (vite-style), not in core.

## Capabilities

| Capability       | Consulted by        | Contract                                                                               |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `executor(ctx)`  | `plugin-host.ts`    | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs            |
| `cache(ctx)`     | run setup           | return a `CacheLayer` or decline; ALL kept in order and chained (see chained-cache.md) |
| `telemetry(ctx)` | `telemetry-host.ts` | return sink(s) or decline                                                              |
| `eventSink(ctx)` | `plugin-host.ts`    | raw `WireEvent` consumer                                                               |
| `setup(ctx)`     | `installPlugins`    | validate config; throw `UserError`                                                     |
| `teardown()`     | end-of-run          | flush/close; crash-isolated, 3s-bounded                                                |

## Invariants

- **Decline-fast**: every capability must return `undefined` cheaply
  when unconfigured — a plain run with declared-but-unconfigured
  plugins is zero-overhead (measured ~116ms unchanged).
- `setup` throws fail the run with a clean error naming the plugin;
  everything else is crash-isolated (observability never breaks a run).
- `teardown()` and `EventSink.flush()` ARE invoked at end-of-run (since
  2026-07) — plugins may rely on them to drain buffers.
- **No defaults.** Core's own executor and cache are plugins under
  `src/plugins/` (see plugins.md), declared like any other; a workspace
  that declares no executor or no cache fails before any task runs.
