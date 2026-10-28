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
the workspace schema with the nearest hook hinted (X-19). The hooks are a
plain object: a class instance is refused, since its methods live on its
prototype and the copy `definePlugin` makes would drop them.

A factory that takes options calls `refuseUnknownOptions('name()',
options, kinds)` first: Bun strips a config's types, so a misspelt option
(`reapi({ endpont })`) reached the factory as unset and the plugin
declined with no word, and a value of the wrong kind (`process.env.X`
where a boolean or a number belongs, a number where a string does) was
misread or threw a bare TypeError. It refuses the key as core refuses an
unknown config field, naming the allowed keys and the nearest one, and a
value of the wrong kind naming the kind. `kinds` is a
`PluginOptionKinds<Options>`: each option with the one kind its type
allows (`'array'` for a list, `'any'` for a union of kinds), derived from the interface, so the
type checker refuses a missing option, an extra one or a wrong kind.
Every first-party factory calls it. Its third argument was a list of
names until 0.0.397; it is the kinds record since.

## Capabilities

| Capability             | Consulted by                         | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config(ws, ctx)`      | every verb, first                    | edit the workspace config in place before anything is derived from it (`cache.dir` too); re-validated after EACH plugin; `ctx.setBranch` names the branch's cache scope and base (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `discover(ctx)`        | every discovery, after core's        | return `DiscoveredProject[]` (`{ dir, name?, deps?, reach? }`): a `name`d directory that is not a project becomes one; an existing one keeps its name (another is refused). `deps` (order: `^task`; reach: `--filter`, `--affected`) and `reach` (reach only) are directories, unioned over plugins after the stage, the only project edges core has (with none returning `deps`, a `^task` is refused); a target that is no project is refused; `ctx.projects` is core's and earlier plugins', `ctx.cacheDir` the run's, `ctx.worktreeChanges()` the paths the run's own `git status` lists (null outside git), so a plugin keyed on the worktree walks it once with core. Refusals name the plugin |
| `project(cfg, ctx)`    | per loaded config                    | add/remove/edit a project's tasks in place; core re-validates after EACH plugin, by name; `ctx.lock` is true in `vx lock`'s pass, the place to report what a mapping could not say (a run checks nothing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `graph(nodes, ctx)`    | after graph build                    | edit `deps`/`requested`/`config` in place; the builder's checks run again (item 981), each task config is re-validated after EACH plugin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `key(task, ctx)`       | per task, at hash                    | a plain `{ name: value }` record folded into the key and named in `vx why`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fingerprint`          | claim, static                        | `{ files, affected(change, ctx) }`: the workspace-fingerprint files this plugin keys per project; one claimant each; `affected` answers names from `ctx.projects`, else it is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `schedule(nodes, ctx)` | once, if a task will start           | task id → weight, merged over the structural baseline; later plugin wins per task. Awaited before the first task, so it answers from what is at hand; `ctx.refs` are the refs the run reads, as `CacheContext.refs`; `ctx.refine(weights)` replaces the plugin's weights later and re-ranks the tasks not yet started (fetched timings), never holding the run; `ctx.onRefine(listener)` calls back when another plugin refines, so a plugin that read history here reads it again; `ctx.refine(promise)` promises weights, and `ctx.refining()` settles once every promised refine has landed, so a plugin that sizes the run by fetched data (vx-dte's workers) waits for it                       |
| `admit(task, ctx)`     | every local dispatch                 | `false` holds a ready task beside `ctx.running` until something finishes (with nothing running, it is overridden, by name); a persistent task leaves `ctx.running` at ready, when it frees its worker; sync, cheap; a throw, a Promise or an answer not `true`/`false`/`undefined` admits from then on                                                                                                                                                                                                                                                                                                                                                                                               |
| `commands`             | unknown CLI verb                     | `{ verb: { description, run(argv, ctx) } }` (`ctx.cache` read-only, opened on first use; `ctx.artifacts` saves and restores task entries by key under a run's policy and scope; `ctx.artifactsFor(facts)` does it under another run's refs and lent access, the `CacheContext.lent` a plugin's remote reads); a core verb's name, an empty one or one opening with `-` is refused; `vx help`                                                                                                                                                                                                                                                                                                         |
| `executor(ctx)`        | `plugin-host.ts`                     | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs; `ctx.artifacts` (`TaskArtifacts`) saves and restores task entries by key in the run's cache, for a task another machine ran; `ctx.cacheFacts()` is what that machine reads the cache under (`CacheFacts`: the run's refs and each remote's `lend`)                                                                                                                                                                                                                                                                                                                                                                      |
| `cache(ctx)`           | run setup                            | return a `RemoteCacheLayer` or decline; core layers each over the local cache, in declared order, under the run policy (plugin-host.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `telemetry(ctx)`       | `telemetry-host.ts`                  | return sink(s) or decline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `output(ctx)`          | `output-host.ts`, before `run:start` | return a `Logger` that draws the run, or decline (`OutputContext`: `ctx.isTTY`, `ctx.ci` say where it would draw); first one wins; one that does not answer within the teardown bound is passed over with a warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `setup(ctx)`           | `installPlugins`                     | validate config; throw `UserError`; `ctx.cache`, `ctx.ci`, `ctx.branch` (below), `ctx.secret` (util-secrets.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `teardown(run?)`       | end-of-run                           | flush/close; crash-isolated, 3s-bounded; `RunReport` when the run ran to its end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## The installer

```ts
installPlugins(args: InstallPluginsArgs): Promise<() => void> // runs each setup; resolves to the uninstall
interface InstallPluginsArgs { plugins; workspaceRoot; cacheDir; bus: EventBus; warn?; cache?(plugin): PluginCache; ci?; branch? }
// What setup(ctx) receives: on(hook, handler) subscribes a lifecycle hook.
interface PluginContext { workspaceRoot; cacheDir; warn(message); bus; cache: PluginCache; ci: boolean; branch: string | null; on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]) }
type PluginHookName = keyof PluginHookHandlers
// 'onRunStart' | 'onTaskStart' | 'onTaskStdout' | 'onTaskStderr' | 'onTaskComplete' | 'onRunStatus' | 'onRunEnd'
```

## `ctx.cache`

`setup` and `schedule` receive the plugin's own entries in the cache the
workspace declares (`PluginCache`, `cache/plugin-cache.ts`; design
`design/shared-timings-2026-10.md`): `get(name, scoped?)`, `put(name, bytes)`,
`has(name, scoped?)`, `hasMany(names, scoped?)`. The local store (the shared store's
`plugin_blobs`) answers first, then each remote in declared order, under
the run's policy (a read-only remote is never written) and scope: a
scoped run writes only the scope's entry and reads one, the scope's, or
with `scoped` false the default (base branch) entry. Core
derives each key from the plugin's name and the entry's
(`xxh3('vx-plugin\0' + plugin + '\0' + name)`), so a plugin reaches no
other plugin's entries and no task's. A `put` never replaces an entry:
the local store keeps the first, and core sends each remote the `put`
alone, asking no `has` first; a remote keeps what it holds. An entry is at most 1 MiB; a remote
body over that is a miss, read no further. Every failure is an absent
answer, never a throw or a warning; `hasMany` is `null` when a readable
remote has no batch probe. With no remote, `get` is a local lookup.
`schedule` runs after `setup` (only a run that starts a task schedules).
`tests/plugin-cache.test.ts`.

## Run report and run bytes

A run that writes a remote (CI by default) keeps its own bytes there
(`cache/run-store.ts`): the log of a task that saved no entry, and a
failed task's log and a tar of the files its declared outputs left when
`cache.upload.failures` (`'ci'`, the default; `'local'`; `'always'`)
covers the run. Each task's bytes leave when it ends, off its path; the
run waits for them where it waits for its uploads (shown as `vx:uploads`
when it does), and the footer counts the task under `remote ↑`. A task that saved an
entry keeps its log in the entry; nothing goes to the local cache, where
`vx last --log` and the tree already hold it. Names are
`run/<runId>/<taskId>/log|outputs`, each key derived in its own
namespace (no task key or plugin entry shares it), scoped as tasks are,
uncapped. A run that ran to its end then calls each `teardown(run)` with
a `RunReport`: `runId` (its history rows' `run_id`), `commit`, `ciRun`
(`detectCi`: provider, run URL, change, pipeline, job, attempt), `ok`
and every task (`id`, `status`, `durationMs`, `key`, and `log` /
`outputs` names when kept). `ctx.cache.getRun(name)` reads one from the
first readable remote. Core writes no manifest: a plugin that wants a
run record writes one from the report with `ctx.cache.put`.

```ts
interface RunReport {
  runId: string
  commit: string | null
  ciRun: CiContext
  ok: boolean
  tasks: readonly RunReportTask[]
}
interface RunReportTask {
  id: string
  status: TaskStatus
  durationMs: number
  key?: string
  log?: string
  outputs?: string
}
```

`tests/plugin-run-facts.test.ts`; `tests/plugin-run-record.test.ts` builds
a run explorer's record on this API and reads it back through a verb.

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
  and a throwing `admit` (or one that answers a Promise, or anything not
  `true`, `false` or `undefined`) admits from then
  on. An async hook's rejection counts as its throw. `ctx.on` with a
  hook name it does not know fails the load (H-16), as does a handler (or
  a `ctx.bus.subscribe` subscriber) that is not a function.
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
  local executor is the tail of every executor list and its local cache
  is asked first in every cache chain (see plugin-host.md), so a
  workspace that declares nothing
  runs and caches here.

## Branch facts

A CI knows what git may not: the branch a detached checkout builds and
the commit a pull request is compared with. The `config` stage says so:

```ts
export interface BranchFacts {
  scope?: string // the cache scope, `<owner>/<repo>:<branch>`; VX_CACHE_SCOPE beats it
  base?: string // the commit a bare --affected and the scope split diff from
  trusted?: boolean // no scope, whatever git names: only the default keys (a merge queue)
  refs?: readonly string[] // the refs a remote reads, in order; unset, git's (cacheRefs)
}
export interface ConfigContext extends WorkspaceHookContext {
  setBranch(facts: BranchFacts): void // a later plugin's field wins; a bad scope, base or ref is refused
}
```
