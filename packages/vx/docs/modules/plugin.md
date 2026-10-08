# `src/orchestrator/plugin.ts` — the VxPlugin interface + installer

## Purpose

The integration seam. A plugin is `definePlugin(import.meta, hooks)`
— its name is the name of the package it is defined in, read from the
nearest `package.json` and stamped where the workspace loader checks,
never a field — with at least one capability; `defineWorkspace({
plugins: [...] })` activates it. Core
consults capabilities at fixed points and otherwise ignores plugins —
behavior lives in the plugin package (vite-style), not in core. A
`package.json` that does not parse is refused naming the file (X-20),
and a key on the plugin that names no hook (`excutor`) is refused by
the workspace schema with the nearest hook hinted (X-19).

A factory that takes options calls `refuseUnknownOptions('name()',
options, kinds)` first: Bun strips a config's types, so a misspelt option
(`reapi({ endpont })`) reached the factory as unset and the plugin
declined with no word, and a value of the wrong kind (`process.env.X`
where a boolean or a number belongs, a number where a string does) was
misread or threw a bare TypeError. It refuses the key as core refuses an
unknown config field, naming the allowed keys and the nearest one, and a
value of the wrong kind naming the kind. `kinds` is a
`PluginOptionKinds<Options>`: each option with the one kind its type
allows (`'any'` for a union of kinds), derived from the interface, so the
type checker refuses a missing option, an extra one or a wrong kind.
Every first-party factory calls it. Its third argument was a list of
names until 0.0.397; it is the kinds record since.

## Capabilities

| Capability             | Consulted by                  | Contract                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config(ws, ctx)`      | every verb, first             | edit the workspace config in place before anything is derived from it (`cacheDir` too); re-validated after EACH plugin                                                                                                                                                                                                             |
| `discover(ctx)`        | every discovery, after core's | return `{ dir, name }[]`: directories that become projects beyond the members; `ctx.projects` is core's and earlier plugins', `ctx.cacheDir` the run's, `ctx.worktreeChanges()` the paths the run's own `git status` lists (null outside git), so a plugin keyed on the worktree walks it once with core. Refusals name the plugin |
| `project(cfg, ctx)`    | per loaded config             | add/remove/edit a project's tasks in place; core re-validates after EACH plugin, by name                                                                                                                                                                                                                                           |
| `graph(nodes, ctx)`    | after graph build             | edit `deps`/`requested`/`config` in place; the builder's checks run again (item 981), each task config is re-validated after EACH plugin                                                                                                                                                                                           |
| `key(task, ctx)`       | per task, at hash             | `{ name: value }` material folded into the key and named in `vx why`                                                                                                                                                                                                                                                               |
| `fingerprint`          | claim, static                 | `{ files, affected(change, ctx) }`: the workspace-fingerprint files this plugin keys per project; one claimant each                                                                                                                                                                                                                |
| `schedule(nodes, ctx)` | before scheduling             | task id → weight, merged over the structural baseline; later plugin wins per task                                                                                                                                                                                                                                                  |
| `admit(task, ctx)`     | every local dispatch          | `false` holds a ready task beside `ctx.running` until something finishes (with nothing running, it is overridden, by name); a persistent task leaves `ctx.running` at ready, when it frees its worker; sync, cheap; a throw or a Promise admits from then on                                                                       |
| `commands`             | unknown CLI verb              | `{ verb: { description, run(argv, ctx) } }`; a core verb's name, an empty one or one opening with `-` is refused; `vx help`                                                                                                                                                                                                        |
| `executor(ctx)`        | `plugin-host.ts`              | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs                                                                                                                                                                                                                                                        |
| `cache(ctx)`           | run setup                     | return a `CacheLayer` or decline; ALL kept in order and chained (see chained-cache.md)                                                                                                                                                                                                                                             |
| `telemetry(ctx)`       | `telemetry-host.ts`           | return sink(s) or decline                                                                                                                                                                                                                                                                                                          |
| `setup(ctx)`           | `installPlugins`              | validate config; throw `UserError`                                                                                                                                                                                                                                                                                                 |
| `teardown()`           | end-of-run                    | flush/close; crash-isolated, 3s-bounded                                                                                                                                                                                                                                                                                            |

## The installer

```ts
installPlugins(args: InstallPluginsArgs): Promise<() => void> // runs each setup; resolves to the uninstall
interface InstallPluginsArgs { plugins; workspaceRoot; cacheDir; bus: EventBus; warn? }
// What setup(ctx) receives: on(hook, handler) subscribes a lifecycle hook.
interface PluginContext { workspaceRoot; cacheDir; warn(message); bus; on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]) }
type PluginHookName = keyof PluginHookHandlers
// 'onRunStart' | 'onTaskStart' | 'onTaskStdout' | 'onTaskStderr' | 'onTaskComplete' | 'onRunStatus' | 'onRunEnd'
```

## Invariants

- **Decline-fast**: every capability must return `undefined` cheaply
  when unconfigured — a plain run with declared-but-unconfigured
  plugins is zero-overhead (measured ~116ms unchanged).
- A throw in `setup`, a stage (`config`, `discover`, `project`, `graph`,
  `key`, `fingerprint`'s `affected`, `schedule`) or an `executor` /
  `cache` factory fails the run in one
  line naming the plugin and the hook: what a plugin shapes is
  load-bearing. The observers are isolated (observability never breaks a
  run): a `telemetry` factory or sink, a `ctx.on` handler or `ctx.bus` subscriber (switching off its whole plugin, not its package) and `teardown`
  are warned and switched off,
  and a throwing `admit` (or one that answers a Promise) admits from then
  on. An async hook's rejection counts as its throw. `ctx.on` with a
  hook name it does not know fails the load (H-16).
- `teardown()` and every telemetry sink's `flush()` ARE invoked at
  end-of-run, each under try/catch and a time bound — plugins may rely
  on them to drain buffers. A run a SIGINT/SIGTERM/SIGHUP stops is no
  exception (item 849), nor is one that never started its schedule (a
  refused setup, a factory that threw, an unresolved name) or a plan
  (item 1021); a second signal, or a `kill -9`, is. A plugin whose own
  `setup` threw is not torn down. Its `ctx.on` handlers and telemetry
  sinks are released just before `teardown()`, so it hears nothing after
  it, a server vx keeps in the foreground included (C-66). (The older `eventSink` seam is gone since
  pipeline v2; `setup(ctx)` on the bus and `telemetry` are the two
  observe paths.)
- **No defaults, one floor.** Core applies no plugin on its own; its
  local executor and local cache are appended at the tail of every list
  and chain (see plugin-host.md), so a workspace that declares nothing
  runs and caches here.
