# `src/orchestrator/plugin.ts` — the VxPlugin interface + installer

## Purpose

The integration seam. A plugin declares a `name` plus at least one
capability; `defineWorkspace({ plugins: [...] })` activates it. Core
consults capabilities at fixed points and otherwise ignores plugins —
behavior lives in the plugin package (vite-style), not in core.

## Capabilities

| Capability             | Consulted by        | Contract                                                                               |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `executor(ctx)`        | `plugin-host.ts`    | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs            |
| `config(ws, ctx)`      | `prepareRun`, first | edit the workspace config in place before anything is derived from it                  |
| `project(cfg, ctx)`    | per loaded config   | add/remove/edit a project's tasks in place; core re-validates after the last plugin    |
| `graph(nodes, ctx)`    | after graph build   | edit `deps`/`requested`/resources in place; dangling deps and cycles are refused       |
| `key(task, ctx)`       | per task, at hash   | `{ name: value }` material folded into the key and named in `vx why`                   |
| `schedule(nodes, ctx)` | before scheduling   | task id → weight, merged over the structural baseline; later plugin wins per task      |
| `commands`             | unknown CLI verb    | `{ verb: { description, run(argv, ctx) } }`; core verbs win; listed by `vx help`       |
| `cache(ctx)`           | run setup           | return a `CacheLayer` or decline; ALL kept in order and chained (see chained-cache.md) |
| `telemetry(ctx)`       | `telemetry-host.ts` | return sink(s) or decline                                                              |
| `setup(ctx)`           | `installPlugins`    | validate config; throw `UserError`                                                     |
| `teardown()`           | end-of-run          | flush/close; crash-isolated, 3s-bounded                                                |

## Invariants

- **Decline-fast**: every capability must return `undefined` cheaply
  when unconfigured — a plain run with declared-but-unconfigured
  plugins is zero-overhead (measured ~116ms unchanged).
- `setup` throws fail the run with a clean error naming the plugin;
  everything else is crash-isolated (observability never breaks a run).
- `teardown()` and every telemetry sink's `flush()` ARE invoked at
  end-of-run, each under try/catch and a time bound — plugins may rely
  on them to drain buffers. (The older `eventSink` seam is gone since
  pipeline v2; `setup(ctx)` on the bus and `telemetry` are the two
  observe paths.)
- **No defaults.** Core's own executor and cache are plugins under
  `src/plugins/` (see plugins.md), declared like any other; a workspace
  that declares no executor or no cache fails before any task runs.
