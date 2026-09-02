# The pipeline — plugin API v2 (2026-09)

**Status: accepted design, shipping in phases (see the phase list).**

## Why

The owner's direction (2026-09-02): vx is the Vite of task orchestration.
Core is a pipeline; plugins decide what happens at each stage. Today core
has three seams — `executor`, `cache`, `telemetry` — plus a raw event-bus
`setup` hook and a deprecated `eventSink`. That is enough to move a task
to a remote worker and to export a run, and not enough to *add a task*,
*reshape the graph*, *fold extra material into a key*, *choose an
order*, or *add a verb*. Each of those is something a workspace has had
to hand-write in every config, or something core had to grow a flag for.

The test of the design: every feature core removed on 2026-09-02 —
predictive scheduling, `vx mcp` — must be expressible as a plugin, and
the features that remain in core must not need a special case for any
one consumer.

## Shape

One `VxPlugin` object, hooks named by the pipeline stage they run in,
in pipeline order:

| Stage       | Hook                                  | Runs                       | Can change                                        |
| ----------- | ------------------------------------- | -------------------------- | ------------------------------------------------- |
| workspace   | `config(ws, ctx)`                     | once, before discovery     | the workspace config (concurrency, cacheDir, …)   |
| project     | `project(config, meta, ctx)`          | once per loaded project    | the project's tasks (add, remove, edit)           |
| graph       | `graph(nodes, ctx)`                   | once, after the task graph | edges, `requested`, resources                     |
| key         | `key(task, ctx)`                      | once per task, at hash     | extra key material (folded, never replaces)       |
| schedule    | `schedule(nodes, ctx)`                | once, before scheduling    | per-task priorities (the two-tier scheduler input) |
| execute     | `executor(ctx)`                       | once per run               | WHERE one task's command runs (existing)          |
| store       | `cache(ctx)`                          | once per run               | WHERE artifacts live (existing)                   |
| observe     | `telemetry(ctx)`                      | once per run               | nothing — records out (existing)                  |
| observe     | `setup(ctx)` / `teardown()`           | once per run               | nothing — raw bus subscription (existing)         |
| cli         | `commands`                            | on an unknown verb         | which verbs exist                                 |

Rules that keep it a pipeline and not a soup:

1. **Order is declaration order, everywhere.** `plugins: [a, b]` means
   `a.project` runs before `b.project`, `a.executor` is asked before
   `b.executor`. No priorities, no `enforce: 'pre'`. (Vite needed
   `enforce` because its plugins come from many ecosystems; vx's are
   declared by one hand in one file.)
2. **A transform hook mutates in place and returns nothing.** `project`
   receives the validated config object and may edit it; core
   re-validates after the last plugin, so a plugin cannot produce a
   config the loader would refuse from a user. Same for `graph`.
3. **Everything a hook changes reaches the cache key by construction.**
   Resolved-config hashing (principle #4) hashes the task config *after*
   `project` ran, so an injected task or edited command re-keys exactly
   like a hand edit. `key` material is folded as one more part. `graph`
   edits change `dependsOn` closure, which changes upstream folding.
4. **Observe hooks cannot change behaviour.** `telemetry` keeps its
   handle-free contract. `setup` gets the bus, read-only.
5. **No hook is applied by default.** A workspace with no `executor` or
   `cache` still fails before any task runs, naming the fix.
6. **Zero cost when absent.** No plugin declares `project` ⇒ no loop, no
   re-validation. Same for every stage. The warm path is measured.
7. **Crash isolation is per stage.** Load-bearing stages (`config`,
   `project`, `graph`, `key`, `schedule`, `executor`, `cache`) abort the
   run with a `UserError` naming plugin and hook. Observe stages warn and
   disable the plugin for the run.

## Contexts

```ts
interface PluginContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  warn(message: string): void
}
interface ProjectContext extends PluginContext {
  readonly name: string      // package name
  readonly dir: string       // absolute
  readonly packageJson: Record<string, unknown>
}
interface GraphContext extends PluginContext {
  readonly requested: readonly string[]   // task ids the user asked for
}
interface KeyContext extends PluginContext {
  readonly task: TaskNode
}
```

`schedule` returns `ReadonlyMap<string, number>` (task id → priority);
higher runs first among ready tasks; merged over the structural baseline
exactly as `runGraph`'s existing `priorities` input.

`commands` is `Record<string, (argv: readonly string[], ctx: CommandContext) => Promise<number>>`.
The CLI dispatcher tries core verbs first; on an unknown verb it loads
the workspace config and asks each plugin, in order. `vx --help` lists
plugin verbs after core's when a workspace is present.

## What moves out of core once this lands

- `vx migrate`, `vx prune`, `vx upgrade` → `@vzn/vx-cli-extras` (or one
  package each). Core's verb list becomes: `run`, `watch`, `show`,
  `why`, `last`, `info`, `cache`, `lock`.
- An MCP server → `@vzn/vx-mcp` (`commands: { mcp }`), reading the same
  run-history queries `vx why` / `vx last` use through the public API.
- Predictive scheduling → a `schedule` plugin reading `LocalHistoryProvider`.

## What does NOT change

- The three existing seams keep their contracts; `@vzn/vx-reapi`,
  `@vzn/vx-otel`, `@vzn/vx-github` run unmodified.
- `eventSink` (deprecated) is removed; `setup(ctx)` with the bus is the
  raw-event path, `telemetry` is the export path.
- Config evaluation caching is unaffected: the cache stores the config as
  the user wrote it; `project` transforms apply after the load, live.

## Phases

1. **Remove `eventSink`; add `config`, `project`, `graph`.** Pins: an
   injected task runs and keys like a hand-written one; the graph hook can
   add an edge; a hook throwing is a named `UserError`; no hook ⇒ the
   loader and graph builder are byte-identical (a probe that counts
   validations).
2. **`commands`.** Move `migrate`, `prune`, `upgrade` out behind it.
3. **`schedule`, `key`.** Ship a `@vzn/vx-schedule-history` reference
   plugin (the old predictive mode) to prove the seam.
4. Docs + site: the plugin guide is rewritten around the stage table.
