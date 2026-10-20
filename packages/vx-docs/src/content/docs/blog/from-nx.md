---
title: 'Moving to vx from Nx: keep the graph, drop the platform'
date: 2026-09-10T23:31:00Z
authors:
  - vzn
tags:
  - migration
  - nx
excerpt: "Moving an Nx repo to vx: `vx init` writes native config from the resolved project graph Nx itself uses, so plugin-inferred targets come along, and an executor target migrates as an `nx-exec` line for you to rewrite as its command."
---

Leaving Nx is a bigger step than leaving Turborepo, and the honest
version of this post says why before it says how. You keep the things
you relied on: the task graph, caching, `affected`. You shed the
daemon, the executor plugins and the generators. If you were using
the generators as a scaffolding system, that is a real loss and vx
does not replace it. If you were using Nx as a task runner, everything
below is a simplification.

## One command

`npx @vzn/vx init` beside `nx.json` is the whole adoption. It writes
one `vx.config.ts` per project, a `.vx/workspace.ts` declaring your
lockfile's plugin, and `.vx/projects.lock.json`, and installs vx with
your own package manager:

```bash
npx @vzn/vx init              # native vx.config.ts files, .vx/workspace.ts, the lock
npx @vzn/vx run build --all   # what nx run-many -t build did, under vx's cache
```

Executor targets keep running as executors at first. Each becomes an `nx-exec`
line that runs the executor in its own Node process through Nx's public
`runExecutor`, with the executor and its options on the command line,
so vx's key sees them and `vx show` prints what runs.

## Read the graph Nx actually uses

Nx's real configuration is not `nx.json`; it is the resolved project
graph, after every plugin has inferred its targets. `vx init` reads
that: it asks your installed `nx` for the graph (`nx graph`) rather
than guessing at plugin-inferred targets from `nx.json`, so those
targets come along. The files it writes freeze that snapshot as static
config: review them and fill the TODOs.

To check the mapping before any config exists, `npx @vzn/vx init --keep`
writes only a `.vx/workspace.ts` that runs the graph through `nx()` from
`@vzn/vx-migrate`, installs what it imports, and its `next:` line builds
once:

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { nx } from '@vzn/vx-migrate'
import { npm } from '@vzn/vx-lockfile'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default {
  plugins: [
    nx(),
    npm(),
    scheduleHistoryPlugin(),
  ],
} satisfies WorkspaceConfig
```

It is a check, not a way to keep Nx's config: vx's benchmarks measure
only native config. `bunx @vzn/vx-migrate --dry` then previews the
files, and `bunx @vzn/vx-migrate` writes them and drops `nx()`.

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
  inputs: { files: ['src/**', 'tsconfig.lib.json'] }, cache: { outputs: { files: ['dist/**'] } },
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

## What maps

| Nx                                    | vx                                            |
| ------------------------------------- | --------------------------------------------- |
| a project's `targets`                 | `tasks`                                       |
| `dependsOn` (`^build`, …)             | `dependsOn`, same syntax                      |
| `inputs` / `namedInputs` (resolved)   | `inputs.files`                          |
| `{workspaceRoot}/file`                | `inputs.workspaceFiles`                 |
| `outputs`                             | `cache.outputs.files`                         |
| `nx affected`                         | `vx run … --affected[=<base>]`                |
| `nx run-many --projects`              | `vx run … --filter`                           |
| `parallelism: false`                  | a TODO naming `--concurrency 1`               |
| `nx watch`                            | `vx watch`                                    |
| `targetDefaults`                      | already applied in the graph; share them as a preset you import |

`namedInputs` and `targetDefaults` never reach the migration as
themselves: the resolved graph has already applied them, so what gets
written is each task's own `inputs.files` and its own values.
Neither exists in vx and neither will — a TypeScript config composes,
so a shared input list is an import.

## What you drop, and what replaces it

- **The daemon.** vx has [none](../no-daemon/). On the 9,603-task
  benchmark, on native config, with nothing changed vx adds 757 ms to
  Nx's 22.63 s, and the cold run burns 30.06 s of
  runner CPU to Nx's 5 min 45 s.
  Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
  Run 2026-10-12 on linux x64, 4 cores, concurrency 10: vx from source, Turborepo 2.11.7, Nx 23.3.0, Vite Task (vite-plus) 1.1.0.
- **Nx Cloud's distributed execution.** The seam is public:
  `@vzn/vx-reapi` runs tasks on any Bazel Remote Execution API pool.
  There is no first-party service and there will not be one.
- **Nx Cloud's remote cache.** `nxCache()` from `@vzn/vx-migrate` speaks the
  self-hosted `/v1/cache` wire, so an existing self-hosted server keeps
  working. Any other wire is a `cache` plugin.
- **Nx Cloud's flaky-test detection.** vx [detects flaky
  tasks](../flaky-tasks/) from the local run history: a key that has
  both passed and failed on record, no service involved.
- **The graph visualiser.** `vx run build --all --dry=json` lists each
  task with its deps, ready for any tool that draws a graph; `vx show`
  prints what a run would see.

The full guide, with the trade-offs spelled out one by one, is
[Migrate from Nx](../../guides/migrate/#nx).
