---
title: 'From Nx: keep the graph, drop the platform'
date: 2026-09-10T23:31:00Z
authors:
  - vzn
tags:
  - migration
  - nx
excerpt: "Leaving Nx means trading executors for shell commands and a daemon for none. `bunx @vzn/vx-migrate` reads the resolved project graph Nx itself uses, so plugin-inferred targets come along, with a TODO where a command has to be yours."
---

Leaving Nx is a bigger step than leaving Turborepo, and the honest
version of this post says why before it says how. You keep the things
you relied on: the task graph, caching, `affected`. You shed the
daemon, the executor plugins and the generators. If you were using
the generators as a scaffolding system, that is a real loss and vx
does not replace it. If you were using Nx as a task runner, everything
below is a simplification.

## The one real shift: executors become commands

An Nx target runs through an executor, a plugin that wraps a tool
behind a JSON options object:

```jsonc
{ "build": { "executor": "@nx/js:tsc", "options": { "main": "src/index.ts", "tsConfig": "tsconfig.lib.json" } } }
```

vx has no executors. A task is the shell command the executor would
have run:

```ts
build: {
  exec: { command: 'tsc -b tsconfig.lib.json' },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}
```

More explicit, more portable, and one less layer between you and the
tool's own documentation. The cost is that every executor-backed target
needs a real command. The migration infers it for the common ones
(`@nx/vite:*`, `@nx/vitest:test`, `@nx/jest:jest`, `@nx/eslint:lint`,
`@nx/js:tsc`) under a TODO asking you to check it against the
executor's options, and leaves a `TODO(vx-migrate)` placeholder where
it cannot. Nothing is silently wrong.

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
placeholders, fill the TODOs.

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
| `parallelism: false`                  | `exec.resources` reserving the whole budget   |
| `nx watch`                            | `vx watch`                                    |
| `targetDefaults`                      | a preset file you import and spread           |

`namedInputs` are resolved into each task's `cache.inputs.files` by the
migration. They do not exist in vx and will not: a TypeScript config
composes, so a shared input list is an import.

## What you drop, and what replaces it

- **The daemon.** vx has [none](../no-daemon/). On the 3,270-task
  benchmark a fully cached run is 510 ms to Nx's 3.59 s, and the cold
  run burns 35 s of CPU to Nx's 114 minutes.
- **Nx Cloud's distributed execution.** The seam is public:
  `@vzn/vx-reapi` runs tasks on any Bazel Remote Execution API pool.
  There is no first-party service and there will not be one.
- **Nx Cloud's remote cache.** `@vzn/vx-nx-cache` speaks the
  self-hosted `/v1/cache` wire, so an existing self-hosted server keeps
  working. Any other wire is a `cache` plugin.
- **Nx Cloud's flaky-test detection.** vx [detects flaky
  tasks](../flaky-tasks/) from the local run history: a key that has
  both passed and failed on record, no service involved.
- **The graph visualiser.** `vx run --graph` renders DOT; `vx show`
  prints what a run would see.

The full guide, with the trade-offs spelled out one by one, is
[Migrate from Nx](../../migrate/from-nx/).
