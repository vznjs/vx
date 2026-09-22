---
title: 'From Nx: keep the graph, drop the platform'
date: 2026-09-10T23:31:00Z
authors:
  - vzn
tags:
  - migration
  - nx
excerpt: "Run an Nx repo under vx unchanged with `nx()`, executors included, then trade executors for shell commands at your pace. `bunx @vzn/vx-migrate` reads the resolved project graph Nx itself uses, so plugin-inferred targets come along, and an executor target migrates as the `nx-exec` line that runs it."
---

Leaving Nx is a bigger step than leaving Turborepo, and the honest
version of this post says why before it says how. You keep the things
you relied on: the task graph, caching, `affected`. You shed the
daemon, the executor plugins and the generators. If you were using
the generators as a scaffolding system, that is a real loss and vx
does not replace it. If you were using Nx as a task runner, everything
below is a simplification.

## Try it unchanged first

Nothing has to be written to find out what vx does for the repo. `nx()`
from `@vzn/vx-migrate` fills vx's `project` stage from the resolved
project graph, so every project's targets are vx tasks with their
inputs, outputs and `dependsOn`, and `vx run build --all` runs what
`nx run-many -t build` ran, under vx's cache:

```ts
// vx.workspace.ts — the only file
import { defineWorkspace } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

Executor targets keep running as executors. Each becomes an `nx-exec`
line that runs the executor in its own Node process through Nx's public
`runExecutor`, with the executor and its options on the command line,
so vx's key sees them and `vx show` prints what runs. A warm vx run
never runs Nx at all; the plugin exports the graph again only when
`nx.json` or a `project.json` changes. (Added 2026-09-22.)

## The one real shift: executors become commands

An Nx target runs through an executor, a plugin that wraps a tool
behind a JSON options object:

```jsonc
{ "build": { "executor": "@nx/js:tsc", "options": { "main": "src/index.ts", "tsConfig": "tsconfig.lib.json" } } }
```

vx has no executors. A task is a shell command. When you migrate, an
executor target is written as the `nx-exec` line that runs it — no
placeholder, the repo runs on day one — and, target by target, that
line becomes the command the executor was wrapping:

```ts
build: {
  exec: { command: 'tsc -b tsconfig.lib.json' },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}
```

More explicit, more portable, and one less layer between you and the
tool's own documentation. Every executor runs through `nx-exec` until
you replace it, `nx:run-commands` targets are the shell they already
were, and the server executors — `@nx/vite:dev-server`,
`@nx/vite:preview-server`, `@nx/webpack:dev-server`, `@nx/next:server`,
`@nx/storybook:storybook` and `@angular-devkit/build-angular:dev-server`
— come through as persistent tasks, whatever the target is called.
Nothing is silently wrong.

## Read the graph Nx actually uses

Nx's real configuration is not `nx.json`; it is the resolved project
graph, after every plugin has inferred its targets. The migration reads
that:

```bash
nx graph --file=.nx/workspace-data/project-graph.json
bun add -d @vzn/vx
bunx @vzn/vx-migrate --dry   # preview the generated vx.config.ts files and a report
bunx @vzn/vx-migrate         # write them; never overwrites without --force
```

If only `nx.json` is present, the tool tells you to run the `nx graph`
command rather than guessing at plugin-inferred targets. The generated
files freeze that snapshot as static config: review them, replace the
`nx-exec` lines when you are ready, fill the TODOs.

## What maps

| Nx                                    | vx                                            |
| ------------------------------------- | --------------------------------------------- |
| a project's `targets`                 | `tasks`                                       |
| `dependsOn` (`^build`, …)             | `dependsOn`, same syntax                      |
| `inputs` / `namedInputs` (resolved)   | `cache.inputs.files`                          |
| `{workspaceRoot}/file`                | `cache.inputs.workspaceFiles`                 |
| `outputs`                             | `cache.outputs.files`                         |
| `nx affected`                         | `vx run … --affected[=<base>]`                |
| `nx run-many --projects`              | `vx run … --filter`                           |
| `parallelism: false`                  | `--concurrency 1`, or a schedule-plugin reservation at or above the worker count |
| `nx watch`                            | `vx watch`                                    |
| `targetDefaults`                      | already applied in the graph; share them as a preset you import |

`namedInputs` and `targetDefaults` never reach the migration as
themselves: the resolved graph has already applied them, so what gets
written is each task's own `cache.inputs.files` and its own values.
Neither exists in vx and neither will — a TypeScript config composes,
so a shared input list is an import.

## What you drop, and what replaces it

- **The daemon.** vx has [none](../no-daemon/). On the 3,270-task
  benchmark a fully cached run is 510ms to Nx's 3.59s, and the cold
  run burns 34.61s of CPU to Nx's 114m 06s.
- **Nx Cloud's distributed execution.** The seam is public:
  `@vzn/vx-reapi` runs tasks on any Bazel Remote Execution API pool.
  There is no first-party service and there will not be one.
- **Nx Cloud's remote cache.** `nxCache()` from `@vzn/vx-migrate` speaks the
  self-hosted `/v1/cache` wire, so an existing self-hosted server keeps
  working. Any other wire is a `cache` plugin.
- **Nx Cloud's flaky-test detection.** vx [detects flaky
  tasks](../flaky-tasks/) from the local run history: a key that has
  both passed and failed on record, no service involved.
- **The graph visualiser.** `vx run --graph` renders DOT; `vx show`
  prints what a run would see.

The full guide, with the trade-offs spelled out one by one, is
[Migrate from Nx](../../migrate/from-nx/).
