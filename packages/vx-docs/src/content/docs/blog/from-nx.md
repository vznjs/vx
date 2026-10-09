---
title: 'Moving to vx from Nx: keep the graph, drop the platform'
date: 2026-09-10T23:31:00Z
authors:
  - vzn
tags:
  - migration
  - nx
excerpt: "Moving an Nx repo to vx: `nx()` is a temporary start, executors included, then executors become shell commands in native config. `bunx @vzn/vx-migrate` reads the resolved project graph Nx itself uses, so plugin-inferred targets come along, and an executor target migrates as an `nx-exec` line for you to rewrite as its command."
---

Leaving Nx is a bigger step than leaving Turborepo, and the honest
version of this post says why before it says how. You keep the things
you relied on: the task graph, caching, `affected`. You shed the
daemon, the executor plugins and the generators. If you were using
the generators as a scaffolding system, that is a real loss and vx
does not replace it. If you were using Nx as a task runner, everything
below is a simplification.

## A temporary start

`nx()` from `@vzn/vx-migrate` is a bridge while you migrate, not a way
to keep Nx's config: vx is fast on native config. It fills vx's `project` stage from the resolved
project graph, so every project's targets are vx tasks with their
inputs, outputs and `dependsOn`, and `vx run build --all` runs what
`nx run-many -t build` ran, under vx's cache. `npx vx init` writes the
one file beside `nx.json`, and its `next:` line installs
`@vzn/vx-migrate` and runs the build:

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { nx } from '@vzn/vx-migrate'

export default { plugins: [nx()] } satisfies WorkspaceConfig
```

Executor targets keep running as executors. Each becomes an `nx-exec`
line that runs the executor in its own Node process through Nx's public
`runExecutor`, with the executor and its options on the command line,
so vx's key sees them and `vx show` prints what runs. A warm vx run
never runs Nx at all; the plugin exports the graph again only when
the worktree changes (`nx.json`, a manifest, a source file). (Added 2026-09-22.)

## The one real shift: executors become commands

An Nx target runs through an executor, a plugin that wraps a tool
behind a JSON options object:

```jsonc
{ "build": { "executor": "@nx/js:tsc", "options": { "main": "src/index.ts", "tsConfig": "tsconfig.lib.json" } } }
```

vx has no executors. A task is a shell command. When you migrate, an
executor target is written as its `nx-exec` line, which still runs the
executor through Nx; the migrator translates none of them. Rewriting
each as the command the executor was wrapping is yours, and it is the
step that lets you remove Nx:

```ts
build: {
  exec: { command: 'tsc -b tsconfig.lib.json' },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}
```

More explicit, more portable, and one less layer between you and the
tool's own documentation. `nx:run-commands` targets are the shell they already
were, and the server executors — `@nx/vite:dev-server`,
`@nx/vite:preview-server`, `@nx/webpack:dev-server`, `@nx/next:server`,
`@nx/storybook:storybook`, `@nx/js:node`, `@nx/js:verdaccio`, `@nx/web:file-server` and
`@angular-devkit/build-angular:dev-server`
— come through as persistent tasks, whatever the target is called, as
does any target Nx itself marks `continuous`.
Nothing is silently wrong.

## Read the graph Nx actually uses

Nx's real configuration is not `nx.json`; it is the resolved project
graph, after every plugin has inferred its targets. The migration reads
that:

```bash
bunx @vzn/vx-migrate --dry   # preview the generated vx.config.ts files and a report
bunx @vzn/vx-migrate         # write them; never overwrites without --force
```

It asks your installed `nx` for the graph (`nx graph`) rather than
guessing at plugin-inferred targets from `nx.json`. In a terminal it
asks native (the default) or keep (`--keep`, the `nx()` file `vx init`
writes), then writes `vx.workspace.ts` and installs what the files
import. The generated
files freeze that snapshot as static config: review them and fill the
TODOs.

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
| `parallelism: false`                  | a TODO naming `--concurrency 1`               |
| `nx watch`                            | `vx watch`                                    |
| `targetDefaults`                      | already applied in the graph; share them as a preset you import |

`namedInputs` and `targetDefaults` never reach the migration as
themselves: the resolved graph has already applied them, so what gets
written is each task's own `cache.inputs.files` and its own values.
Neither exists in vx and neither will — a TypeScript config composes,
so a shared input list is an import.

## What you drop, and what replaces it

- **The daemon.** vx has [none](../no-daemon/). On the 9,603-task
  benchmark, on native config, with nothing changed vx adds 1.07 s to
  Nx's 25.45 s (vx 24× faster), and the cold run burns 32.28 s of
  runner CPU to Nx's 6 min 6 s (vx 11× faster).
  Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
  Run 2026-10-09 on linux x64, 4 cores, concurrency 10: vx from source, Turborepo 2.11.7, Nx 23.3.0, Vite Task (vite-plus) 1.1.0.
- **Nx Cloud's distributed execution.** The seam is public:
  `@vzn/vx-reapi` runs tasks on any Bazel Remote Execution API pool.
  There is no first-party service and there will not be one.
- **Nx Cloud's remote cache.** `nxCache()` from `@vzn/vx-migrate` speaks the
  self-hosted `/v1/cache` wire, so an existing self-hosted server keeps
  working. Any other wire is a `cache` plugin.
- **Nx Cloud's flaky-test detection.** vx [detects flaky
  tasks](../flaky-tasks/) from the local run history: a key that has
  both passed and failed on record, no service involved.
- **The graph visualiser.** `vx run build --all --graph` renders DOT; `vx show`
  prints what a run would see.

The full guide, with the trade-offs spelled out one by one, is
[Migrate from Nx](../../guides/migrate/#nx).
