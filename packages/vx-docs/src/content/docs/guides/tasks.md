---
title: Tasks and dependencies
description: Declare a package's tasks in vx.config.ts, each one shell command, and say which tasks must finish first with dependsOn.
---

Declare what a package can run, and what must run before it. Why? →
[Chapter 2: Tasks](../../guide/tasks/) and
[Chapter 3: Dependencies](../../guide/dependencies/)

## Steps

1. Put a `vx.config.ts` next to the package's `package.json`.
2. Give each task one shell command in `exec.command`. Chain steps with `&&`.
3. List what must finish first in `dependsOn`.
4. Add a `cache` block to skip the task when nothing changed ([Caching](../caching/)).
5. Check the graph: `vx run build --graph` prints it as Graphviz DOT.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    codegen: {
      exec: { command: 'graphql-codegen' },
      cache: { inputs: { files: ['schema.graphql'] }, outputs: { files: ['src/gen/**'] } },
    },
    build: {
      description: 'compile TypeScript to dist/',
      dependsOn: ['codegen', '^build'],
      exec: { command: 'tsc -b' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    e2e: {
      dependsOn: ['build', 'api#build'],
      exec: { command: 'playwright test', timeout: 600_000, retries: 1 },
    },
    // A group: no command, it only runs its dependencies.
    ci: { dependsOn: ['build', 'e2e'] },
  },
})
```

## `dependsOn`

| Form         | Runs first                                                            |
| ------------ | --------------------------------------------------------------------- |
| `'build'`    | `build` in this package                                               |
| `'^build'`   | `build` in each package this one depends on (from `package.json`)     |
| `'api#build'`| `build` in the `api` package                                          |
| `'build.*'`  | every task in this package whose name matches                         |

A task-name pattern is allowed: `dependsOn: ['build.*']` here, `'^build.*'`
in dependencies. Bare wildcards and negation (`*`, `!task`) are not; they
are filters, and go in `cache.inputs.tasks`. `^build` reaches through a
package that has no `build` to the nearest one that does.

When a task fails, vx skips its transitive dependents and lets the rest
run: `--continue=deps-ok`, the default. `--continue=never` stops at the
first failure; `--continue=always` runs the dependents but saves none of
them.

## `exec`

| Field             | Does                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `exec.command`    | the one shell command, run in the package's directory              |
| `exec.env`        | what the command sees ([Environment variables](../environment-variables/)) |
| `exec.timeout`    | kill the task after this many ms                                   |
| `exec.retries`    | re-run a failed task this many times                               |
| `exec.persistent` | a server or watcher that does not exit ([Dev tasks](../dev-tasks/)) |
| `exec.sandbox`    | only the declared files and network ([Sandboxing](../sandboxing/)) |
| `exec.remote`     | `false` keeps it here; `'only'` for a remote pool ([Remote execution](../remote-execution/)) |

`exec.remote` is the one `exec` field stripped from the key: where a task
ran says nothing about what it made. Everything else in the task is in the
key, `description` included, so editing a description costs one re-run.

## Common problems

- **`dependsOn` only for order, not for the key.** Add `cache.inputs.tasks: []`, and the upstream's key stays out of this one's.
- **A cycle.** vx refuses to build the graph and prints the path.
- **A typo in `'pkg#task'`.** A missing package or task is an error, never skipped.

Every field: [the config reference](../../schema/).
