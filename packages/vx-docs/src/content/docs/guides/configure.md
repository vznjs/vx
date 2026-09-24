---
title: Configure
description: Tasks and dependencies, caching, environment variables, dev servers, the workspace file and lockfiles, one section each.
---

Tell vx what each package runs, what it reads and what it may see. Every
field: [the config reference](../../schema/).

## Tasks and dependencies

Each task in a package's `vx.config.ts` is one shell command (chain
steps with `&&`). `dependsOn` says what finishes first.

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

| `dependsOn`   | Runs first                                                        |
| ------------- | ----------------------------------------------------------------- |
| `'build'`     | `build` in this package                                           |
| `'^build'`    | `build` in each package this one depends on (from `package.json`) |
| `'api#build'` | `build` in the `api` package                                      |
| `'build.*'`   | every task in this package whose name matches                     |

A task-name pattern is allowed: `dependsOn: ['build.*']` here, `'^build.*'`
in dependencies. Bare wildcards and negation (`*`, `!task`) are not.
`^build` reaches through a package that has no `build`. A cycle or a
missing `'pkg#task'` is an error.

| When a task fails            | vx                                                        |
| ---------------------------- | --------------------------------------------------------- |
| `--continue=deps-ok` (default) | skips its transitive dependents and runs the rest       |
| `--continue=never`           | stops at the first failure                                |
| `--continue=always`          | runs the dependents, but saves none of them               |

| Field             | Does                                                          |
| ----------------- | ------------------------------------------------------------- |
| `exec.command`    | the one shell command, run in the package's directory         |
| `exec.env`        | what the command sees ([below](#environment-variables))       |
| `exec.timeout`    | kill the task after this many ms                              |
| `exec.retries`    | re-run a failed task this many times                          |
| `exec.persistent` | a server or watcher that does not exit ([below](#dev-tasks))  |
| `exec.sandbox`    | only the declared files and network ([Sandboxing](../sandboxing/)) |
| `exec.remote`     | `false` keeps it here; `'only'` for a remote pool ([Remote execution](../ci/#remote-execution)) |

`exec.remote` is the one `exec` field stripped from the key: where a task
ran says nothing about what it made. The rest is in the key, `description`
included, so editing a description costs one re-run.

## Caching

A task with a `cache` block runs once per set of inputs. List every file
the command reads, and what it writes (`[]` for test or lint). Unsure the
list is complete? Add [`exec.sandbox`](../sandboxing/): an undeclared read
fails the task.

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'vite build', env: { passThrough: ['NODE_ENV'] } },
      cache: {
        inputs: {
          files: ['src/**', 'index.html', '!**/*.test.ts'],
          env: ['NODE_ENV'],
          workspaceFiles: ['tsconfig.base.json'], // from the workspace root
        },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

| The key                | Holds                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Always in it           | the package's `package.json`, the lockfile, the keys of the tasks it depends on, the task's config, arguments after `--` |
| Always excluded        | `node_modules`, `.git`, `.vx`, `*.tsbuildinfo`, `vx-lock.json`, `*.bun-build`, files git ignores, the task's own outputs, a nested project's files |
| Out, when you say so   | a dependency only for order: `cache.inputs.tasks: []`, as the [dev task](#dev-tasks) does |

Declared outputs are wiped before every run and every restore, so `dist/`
ends as the cache stored it. A failed task is never saved. `--force` runs
and refreshes the cache; `--no-cache` ignores it.

A fully cached 3,270-task run: vx 510ms, Turborepo 760ms, Nx 3.59s
([benchmarks](../../benchmarks/); the key, part by part:
[Caching in depth](../../caching/)).

### Why did it re-run?

```bash
vx why app#build
```

```console
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed between the previous run and this one (inputs differ)

  what changed (1 component, 41 unchanged):
    changed file  src/index.ts  a1b2c3… → d4e5f6…
```

| The verdict line says | It means |
| --- | --- |
| `cache key changed between the previous run and this one (inputs differ)` | the lines below name what changed |
| `cache key unchanged — this run was served from cache, nothing re-ran` | a hit |
| `cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)` | you forced it, or something unkeyed |
| `cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown` | vx does not guess |
| `` this task declares no `cache` block — it runs on every invocation; its key is folded by dependents only `` | not cached at all |

A hit after you changed something means that something is not declared.

## Environment variables

A task sees only the variables you pass it:

| List                   | The command sees it | The key sees it | Use it for                                          |
| ---------------------- | ------------------- | --------------- | --------------------------------------------------- |
| `exec.env.passThrough` | yes                 | no              | secrets and CI flags (`CI`, `GH_TOKEN`); stays on this machine |
| `cache.inputs.env`     | no                  | yes             | with `passThrough`: a variable that changes the output |
| `exec.env.define`      | yes                 | yes             | a literal value; a remote task gets it too          |

The child always gets a small essential allowlist so normal CLI tools
work: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`,
`TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `FORCE_COLOR`,
`NO_COLOR`, `CI`, `NODE_OPTIONS`, plus the Windows essentials. The
package's `node_modules/.bin` is first on `PATH`. What vx itself reads:
[the CLI reference](../../cli/#environment-variables-vx-reads).

## Dev tasks

A `persistent` task is a server or watcher. Its dependents start once it
prints a line matching `readyWhen`; if none comes, `exec.timeout` fails it.

```ts
// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    dev: {
      exec: { command: 'vite', persistent: { readyWhen: 'Local:' }, timeout: 30_000 },
    },
    e2e: {
      dependsOn: ['dev'],
      exec: { command: 'playwright test' },
      cache: {
        inputs: { files: ['e2e/**'], tasks: [] }, // dev is for order, not the key
        outputs: { files: ['playwright-report/**'] },
      },
    },
  },
})
```

When the run ends, vx sends the server `SIGTERM`. One that ignores it gets
a 2-second grace and is then `SIGKILL`ed. A persistent task has no `cache`
block. A sandboxed server on Linux lists its port in
`sandbox.allow.localBinding`.

## Workspace config

`vx.workspace.ts`, beside the root `package.json`, is optional. Without
it, vx runs and caches on this machine.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.internal:443' })],
  concurrency: 8,            // default: the cores this process may use
  cacheDir: '.vx/cache',     // default: .vx/cache (relative to root)
  timeout: 600_000,
  cacheRetention: { olderThan: '30d', maxSize: '10G' },
})
```

| Field            | Sets                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `plugins`        | asked in order; this machine is always last ([Plugins](../plugins/)) |
| `concurrency`    | tasks at once; `--concurrency <n>` overrides it for one run           |
| `cacheDir`       | where the local cache lives; add it to `.gitignore`                   |
| `timeout`        | a default task timeout in ms; default none                            |
| `cacheRetention` | evict after every run: `olderThan` unused, then least recently used past `maxSize`; default none |

For a timeout, the first one set wins: a task's `exec.timeout`, then
`--timeout <ms>`, then `VX_TASK_TIMEOUT`, then this. It is never in a
cache key. There is no `globalInputs`: import a shared array instead.

## Lockfiles

Without a plugin, the lockfile is in every task's key, so one install
re-runs everything. With `@vzn/vx-lockfile` (`bun add -d @vzn/vx-lockfile`),
each package is keyed on its own dependencies, and `--affected` follows.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()], // pnpm({ scope: 'workspace' }) keys the whole file instead
})
```

| Plugin   | A package's key folds                                                                 | Install-wide, for every package |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `pnpm()` | every package it reaches, by name, version and resolved peers, with integrity and any patch | `lockfileVersion`, `settings`, `overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum`, `ignoredOptionalDependencies` |
| `bun()`  | the same, through Bun's hoisted layout                                                | `lockfileVersion`, `configVersion`, `overrides`, `patchedDependencies`, `catalog`, `catalogs` |
| `npm()`  | the same, from `package-lock.json` versions 2 and 3                                   |                                 |
| `yarn()` | the same, from a berry lockfile; a yarn 1 lockfile records no workspaces, so every package folds the whole file | |

Every package's key also folds the root package's own dependencies:
their bins run from the root `node_modules/.bin`, which is on every
task's PATH. So bumping a root devDependency re-runs every package.

`vx why` names the part `plugin @vzn/vx-lockfile/pnpm`. An unreadable
lockfile stops the run and names the install to re-run. An import you
never declared is in no package's key.
