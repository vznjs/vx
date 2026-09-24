# An Nx repo under vx with nothing written (2026-09-22)

**Status:** IMPLEMENTED (item 590, 2026-09-22) — `nx-exec`
(`packages/vx-migrate/src/nx-exec.cjs`), the `nx()` plugin
(`src/nx/index.ts`) and the migrator emitting `nx-exec` where it wrote a
placeholder, in one PR. Owner's ask, 2026-09-22: "support nx more, like
their executors; people could start using vx with current nx configs, no
changes; of course this cannot be in core." Then: "ideally we would have
a cli like nx-exec [executor] [options] and we would just translate to
that command."

## The shape

`turbo()` already runs a Turbo repo unchanged: a `project`-stage plugin
maps `turbo.json` to tasks at config time. Nx has the same seam
available and one extra problem: most of its targets are not shell
commands but **executors** — a package's JavaScript function that
receives an options object and an `ExecutorContext`. `nx:run-commands`
and `nx:run-script` are commands; `@nx/js:tsc`, `@nx/vite:build`,
`@nx/jest:jest` and every custom executor are not. Before this the
migrator mapped eight of them to a bare CLI under a todo and wrote a
placeholder for the rest.

Two pieces close the gap, both in `@vzn/vx-migrate`, nothing in core:

1. **`nx-exec`**, a bin that runs one executor as one process. The
   command line carries the executor and its options; Nx's own
   `runExecutor` does the option merging, schema defaults, validation
   and the call.
2. **`nx()`**, a `project`-stage plugin over the resolved Nx project
   graph. `run-commands` and `run-script` targets become their raw
   command (the migrator's mapping, shared); every other executor
   becomes an `nx-exec` line.

## Why `runExecutor`, and why not in vx's process

Nx's devkit exposes `runExecutor(target, overrides, context)` publicly,
and `nx run` is a thin CLI over it. Calling it directly skips yargs,
plugin loading, the task orchestrator, the Nx cache and the daemon
handshake, and keeps executor resolution from the workspace's own
`node_modules`, option merging with configurations, schema defaults,
`{workspaceRoot}` / `{projectRoot}` interpolation and validation.

It cannot run inside vx itself:

- vx is Bun; Nx and its executors are Node programs (the
  `@nx/nx-linux-x64-gnu` native binding, jest workers, esbuild's child).
- A plugin changes WHERE a command runs, never what it is. A function
  call has no command: no sandbox, no env isolation, no kill grace, no
  peak RSS, no per-task stdout. Concurrent executors would interleave
  on one stream.
- Nx does not do it either: its task runner forks `run-executor.js` per
  task, or runs it under a pseudo-terminal, for the same reasons.

So `nx-exec` is one Node process per executed task, spawned by vx like
any command. It runs under the workspace's Node, not Bun, because the
executor decides the runtime.

## The command carries the options (owner's shape, 2026-09-22)

The first sketch was `nx-exec <project>:<target>`, the host reading the
target from the cached graph. The owner asked for the explicit form:

```
nx-exec <executor> --project <name> --target <name> [--configuration <name>] --options '<json>'
```

It is better in vx's own terms:

- **The key sees the options.** Resolved-config hashing holds because
  the options are in the command string; the `project:target` form
  would need a side channel.
- **No ambient state decides what runs.** A stale graph cache would be
  a hidden input in the `project:target` form, and a stale hit under a
  green run is the worst failure class. Here the graph only shapes the
  executor's context; the plugin refreshes it once per run.
- **`vx show` prints the truth**, and the line pastes into a shell.
- **The migrator stops writing placeholders.** Every executor migrates
  mechanically, and the written config keeps working as a team drifts
  off Nx one target at a time.

The trick that keeps it on public API: the host reads the cached
project graph for the `ExecutorContext` executors read (project root,
dependencies for buildable libraries), REPLACES that project's target
in the in-memory graph with `{ executor, options }` from the command
line, and calls `runExecutor({ project, target, configuration })`. Nx's
merge, defaults and validation run unchanged; what runs is what the
command says, never what `project.json` says today. Proven on the
bench: a `@nx/js:tsc` build with an `outputPath` unlike project.json's
wrote to the command's path.

Options travel as one JSON argument, not Nx-style flags: arrays of
objects (`assets`) and nested `run-commands` lists do not round-trip
through dotted flags. `--project` and `--target` stay because executors
read them from the context (tsc's buildable-dependency lookup finds the
same target on each dependency).

Nx resolves `{projectRoot}`, `{workspaceRoot}` and `{projectName}` when
it BUILDS the graph, not when it runs: the cached graph holds
`cwd: "packages/p3"` for a project.json that says `{projectRoot}`.
Proven 2026-09-22. So the plugin and the migrator read the resolved
graph and the command is literal. Configurations are the one thing the
graph keeps unflattened; the plugin flattens the chosen one at config
time.

`context.taskGraph` stays undefined on purpose. `@nx/js:tsc` and
`@nx/webpack` read it only under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH`,
and a synthesised one-task graph would answer "no buildable
dependencies" where the project-graph path walks the real edges. An
absent task graph sends them down the project-graph path.

## Measured (2026-09-22, Node 22.22.2, Nx 22.7.12, synthetic workspace)

Per executed task, one spawned process each, interleaved arms, medians
in ms. Scratchpad `nxbench/`, `nxbench-results.md`.

`nx:run-commands` running `true`, 200 projects, N=10:

| arm                                                                | median |
| ------------------------------------------------------------------ | -----: |
| `sh -c true`                                                       |      2 |
| `node -e 0`                                                        |     27 |
| host, `nx/src` imports                                             |    245 |
| host + `NODE_COMPILE_CACHE`                                        |    214 |
| host, `@nx/devkit` barrel                                          |    292 |
| `nx run … --skip-nx-cache --exclude-task-dependencies`, daemon off |    656 |
| `nx run`, daemon warm                                              |    346 |

Same at 1,000 projects, N=6: host 272, `nx run` daemon off 1,104,
daemon warm 387. `@nx/js:tsc` build, 200 projects, `dist` removed
before each: host 1,495, daemon off 2,249, daemon warm 1,907.

Item 597 (2026-09-22): the bin enables Node's compile cache for its own
process; the fair A/B (the same bin, cache disabled through
`NODE_DISABLE_COMPILE_CACHE=1` against enabled, min-of-15) read 243 →
214 ms min and 272 → 233 median on the noop arm.

What it says: the host beats the CLI in every arm and the gap grows
with the workspace, because the CLI rebuilds the project graph per
invocation (with the daemon off, the only mode a sandbox allows) and
still hashes the task, checks outputs and writes run history with the
cache skipped. The host's own floor is ~220 ms, nearly all of it Nx's
module graph (`require('nx/src/project-graph/project-graph')` alone is
154 ms; the 531 KB graph parses in 4). That floor is paid only on a
miss; a warm vx run pays nothing. `nx/src` deep imports over the
devkit barrel: 50 ms and less variance, and `@nx/devkit` need not be
installed (a workspace with only `nx` and custom executors).

## The plugin

- Source of truth: the resolved graph. Nx keeps one at
  `.nx/workspace-data/project-graph.json` in its own shape, written by
  every daemon-less Nx command; `nx graph --file=<path>` writes
  `{ graph: { nodes, dependencies } }`. The mapper accepts both.
- Freshness: once per run, the plugin stats `nx.json`, every discovered
  project's `project.json` and `package.json`, and the snapshot; when
  the snapshot is older than any of them, or missing, it runs
  `node_modules/.bin/nx graph --file=<snapshot>` and reads that. A
  plugin-inferred target from a file the rule does not stat (a
  `vite.config.ts` edit that changes an inferred target) is refreshed by
  the next Nx command or `nx graph --file`; the README says so. The
  cost on a fresh snapshot is the stats, a few ms at 1,000 projects.
- The mapping is `migrate-nx.ts`'s, shared: what runs live is what the
  migrator would have written, minus the file, the same rule `turbo()`
  keeps. A package's own `vx.config` wins; the plugin fills, never
  overwrites.
- Executors: `nx:run-commands`, a plain `command` and `nx:run-script`
  map as before (shell, `cd` to where Nx ran it); `nx:noop` is a group;
  everything else is `nx-exec <executor> --project … --target …
--options '<json>'` with the default configuration flattened in.
  Each other configuration is its own task, `<target>:<configuration>`,
  same inputs, outputs and edges, `--configuration` passed so executors
  reading `context.configurationName` see it.
- Lifetime: a target is persistent when it says `continuous: true`, never
  when it says `continuous: false`, and, in a graph from an Nx older than
  that field, when its executor is a known server
  (`@nx/vite:dev-server`, …). Never by its name: a cached `nx:run-commands`
  target named `dev` ran uncached on every run while the same target named
  `gen` cached (nx#32610).
- What `nx-exec` needs at run time: `nx` resolvable from the project
  dir (the workspace's `node_modules`), Node on PATH, and the cached
  graph. It never dials the daemon.

## run-commands as one shell line (2026-09-24)

`nx:run-commands` stays a shell line, not an `nx-exec` one: the host's
~220 ms floor per executed task is the price of running an executor, and
a shell command has none. So the line carries Nx's option handling
itself — `normalizeOptions` in `run-commands.impl.ts` and the runners in
`running-tasks.ts`, identical in Nx 22.7 and 23.2 — and
`tests/nx-exec-live.test.ts` holds each shape against Nx's own executor
run through `nx-exec` on the same options and arguments.

- Each command is a subshell, as Nx gives each a shell of its own: one
  command's `exit`, `cd` or `set` stays in it.
- `commands` run in parallel unless `parallel: false` (the schema's
  default). The line starts each as a background job whose failure
  sends `USR1` to the line's shell; its trap TERMs the process group and
  exits 1, Nx's code for a failed parallel run. The group is the task's
  own: vx spawns every task `detached`, and a line pasted into a script
  should run under `setsid sh -c` for the same reason. Joined with `&&`,
  a failing check waited for a server that never exits (nx#28477).
- Arguments: Nx appends every option it does not consume (`--k=v`,
  quoted as it quotes), the `args` option and the command line's
  arguments to each command, as TEXT. vx appends `vx run … -- <args>` to
  the end of the line, so a line of more than one command is a function,
  and a helper appends `"$@"` to each command only when there are
  arguments: an unconditional `"$@"` after `done` is a syntax error with
  none (nx#12165). `{args.name}` is filled from the options at map time;
  one given after `--` does not reach it (a todo).
- `nx-exec` passes what it does not know to Nx's own `createOverrides`,
  and hands the result to `runExecutor`. `runExecutor` derives the
  unparsed list from the parsed overrides and puts positional words
  first, where `nx run` keeps the typed order; the parity rows type
  positionals first for that reason.
- `env` is `exec.env.define` (the key sees it), `color` sets
  `FORCE_COLOR`, `readyWhen` makes the task persistent with the escaped
  string as its pattern. Nx waits for EVERY `readyWhen` string; vx takes
  one pattern, so several are an alternation and a todo. Nx also fails a
  run whose `readyWhen` matched on stderr; vx does not.
- `commands: []` is `true`: Nx completes it at once (nx#31345).
- Reported and not reproduced: `envFile`, per-command `prefix` / `color`,
  `streamOutput: false`, `__unparsed__` in a graph. `usePty`, `tty` and
  `verbose` are display-only here: vx runs no task under a pty.

## What it does not do

- Nx's configuration propagation (`^build` under `--configuration
production` builds dependencies with `production` where they have it)
  is a todo on the `<target>:<configuration>` task; its edges are the
  base target's.
- Batch executors (`NX_BATCH_MODE`) run one task per process here.
- Task-graph-aware executors under `NX_BUILDABLE_LIBRARIES_TASK_GRAPH`
  see no task graph and take the project-graph path.
- Nothing in core. Core keeps `vx init`; the Nx reader, the bin and the
  plugin are `@vzn/vx-migrate`'s.
