---
title: Configure
description: Tasks and dependencies, caching, environment variables, dev servers, the workspace file and lockfiles, one section each.
---

Tell vx what each project runs, what it reads and what it may see: a
`vx.config.ts` per project, and one [`.vx/workspace.ts`](#workspace-config)
at the root that marks the workspace. A project is any directory holding
a `vx.config.ts`, in any language; `vx lock` finds them and records them
in `.vx/projects.lock.json`, so run it after adding one. A project is
named by its config's `name`, else by a plugin (`@vzn/vx-lockfile` gives
the `package.json` name), else by its path (`apps/web`; `//` for the
root). Every field: [the config reference](../../schema/).

## Tasks and dependencies

Each task in a package's `vx.config.ts` is one shell command (chain
steps with `&&`). `dependsOn` says what finishes first.

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

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
      // codegen's output reaches this key through codegen's own key; a key
      // that read it could not be known until codegen ran, so vx refuses it.
      cache: { inputs: { files: ['src/**', '!src/gen/**'] }, outputs: { files: ['dist/**'] } },
    },
    e2e: {
      dependsOn: ['build', 'api#build'],
      exec: { command: 'playwright test', timeout: '10m', retries: 1 },
    },
    // A group: no command, it only runs its dependencies.
    ci: { dependsOn: ['build', 'e2e'] },
  },
})
```

| `dependsOn`   | Runs first                                                        |
| ------------- | ----------------------------------------------------------------- |
| `'build'`     | `build` in this package                                           |
| `'^build'`    | `build` in each package this one depends on ([a lockfile plugin's edges](#lockfiles)) |
| `'api#build'` | `build` in the `api` package                                      |
| `'build.*'`   | every task in this package whose name matches                     |

A task-name pattern is allowed: `dependsOn: ['build.*']` here, `'^build.*'`
in dependencies. Bare wildcards and negation (`*`, `!task`) are not.
A package that declares no `build` gets a default one: a group behind
`^build`, keyed on all its files, so editing a package consumed as source
re-runs its dependents (`vx show` lists it as a group; for a package
with no config it says `default build`). A cycle or a
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
| `exec.interactive` | reads the terminal: a prompt, a REPL, a TUI; runs alone, never cached |
| `exec.remote`     | `false` keeps it here; `'only'` for a remote pool ([Remote execution](../ci/#remote-execution)) |

`exec.remote` is the one `exec` field stripped from the key: where a task
ran says nothing about what it made. The rest is in the key, `description`
included, so editing a description costs one re-run.

## Caching

A task with a `cache` block runs once per set of inputs. List every file
the command reads, and what it writes (`[]` for test or lint). Unsure the
list is complete? Add [`exec.sandbox`](../sandboxing/) with `allow.read`
listing the same files: a workspace read outside it fails the task. The
sandbox checks `allow.read`, never `cache.inputs`, so it catches a missing
input only while the two lists match.

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

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
| Always in it           | the keys of the tasks it depends on, the task's config, arguments after `--` |
| In, with a lockfile plugin | the package's `package.json` and its own dependencies from the lockfile ([Lockfiles](#lockfiles)) |
| Always excluded        | an untracked `node_modules` (an install), `.git`, `.vx/cache`, `.vx/projects.lock.json`, `vx.lock.json`, `.vx/.gitattributes`, `.vx/.gitignore`, `*.bun-build`, `.????????????????-????????.tmp` (Bun's compile scratch), `.vx-tmp-*` (a restore in progress), files git ignores, the task's own outputs, a nested project's files |
| In, when you say so    | a tool's version: `cache.inputs.workspaceRuntime: ['node -v']` runs once per run at the root and folds its output; `runtime` runs in the package |
| Out, when you say so   | a dependency only for order: `cache.inputs.tasks: []`, as the [dev task](#dev-tasks) does |

Declared outputs are wiped before every run that writes the cache and every
restore, so `dist/`
ends as the cache stored it; a hit that finds them already as stored skips
both. A task that adds files beside an upstream task's outputs wipes
nothing before a run and only the files it recorded before a restore. A failed task is never saved. `--force` runs
and refreshes the cache; `--no-cache` ignores it.

Overhead on a 9,603-task run where nothing changed: vx 856 ms,
Turborepo 855 ms, Nx 23.22 s
([benchmarks](../../benchmarks/); the key, part by part:
[Caching in depth](../../caching/)).

Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
Run 2026-10-12 on linux x64, 4 cores, concurrency 10: vx from source, Turborepo 2.11.7, Nx 23.3.0, Vite Task (vite-plus) 1.1.0.

### Why did it re-run?

```bash
vx why app#build
```

```console
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed: file packages/app/src/index.ts

  what changed (1 component, 41 unchanged):
    changed file  packages/app/src/index.ts  a1b2c3… → d4e5f6…

  what to do:
    file  an edit re-runs by design; a file the task does not read belongs out of cache.inputs.files
```

| The verdict line says | It means |
| --- | --- |
| `cache key changed: env MODE, file packages/app/src/index.ts` | those inputs moved (three named, then a count); the lines below show each |
| `cache key changed between the previous run and this one (inputs differ)` | the key moved and neither entry kept its components (pruned, or a failed run saved none) |
| `cache key unchanged — this run was served from cache, nothing re-ran` | a hit |
| `cache key unchanged — the previous run on this key failed and saved nothing, so there was nothing to hit` | a failure saves no entry |
| `cache key unchanged — re-executed because this run did not read the cache (--force, or a --cache-policy without read)` | the run's policy read no cache |
| `cache key unchanged — neither run saved it: each ran beside a failed task (…), and a task run past a failed dependency (--continue) is never cached` | both runs went past a failure under `--continue` |
| `cache key unchanged — the previous run on this key ran beside a failed task (…) and was not saved: a task run past a failed dependency (--continue) is never cached, so there was nothing to hit` | the previous run went past a failure under `--continue` |
| `cache key unchanged — no entry for this key was in the cache when it ran (pruned or evicted), so it executed and saved one` | the entry was gone |
| `cache key unchanged — the previous run on this key executed but no entry for it is in the cache (its save failed, or it was pruned since), so there was nothing to hit` | the previous run's save failed, or a prune took the entry |
| `cache key unchanged — the previous run on this key did not write the cache (--no-cache, or a --cache-policy without write), so there was nothing to hit` | the previous run's policy wrote no cache |
| `cache key unchanged — re-executed on the same key though this run read the cache; vx cannot name the cause` | none of the above; vx cannot name the cause |
| `cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)` | no invocation recorded this run's cache policy, so vx cannot rule the flags out |
| `cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown` | vx does not guess |
| `` this task declares no `cache` block — it runs on every invocation; its key is folded by dependents only `` | not cached at all |
| `this task recorded no cache key (skipped, or a persistent task) — nothing to compare` | no key to compare |
| `no prior run for this (project, task)` | nothing to compare with yet |

A hit after you changed something means that something is not declared.

## Environment variables

Past a small essential allowlist (below), a task sees only the variables you pass it:

| List                   | The command sees it | The key sees it | Use it for                                          |
| ---------------------- | ------------------- | --------------- | --------------------------------------------------- |
| `exec.env.passThrough` | yes                 | no              | secrets and CI flags (`GITHUB_ACTIONS`, `GH_TOKEN`); stays on this machine |
| `cache.inputs.env`     | no                  | yes             | with `passThrough`: a variable that changes the output |
| `exec.env.define`      | yes                 | yes             | a literal value; a remote task gets it too          |
| `exec.env.secret`      | —                   | —               | names whose values (6 characters or more) print as `***`; names holding `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` are masked without it |

The child always gets a small essential allowlist so normal CLI tools
work: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`,
`TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `FORCE_COLOR`,
`NO_COLOR`, `CI`, `NODE_OPTIONS`, `COREPACK_HOME`, `PNPM_HOME`. vx sets
`VX_RUN_WORKSPACE` (the workspace root) and `VX_RUN_TASK` (the
`project#task` running) on every task, and `npm_execpath` to the
workspace's package manager, as `pnpm run` does, so npm-run-all needs
no global npm. The package's `node_modules/.bin`
is first on `PATH`. What vx itself reads:
[the CLI reference](../../cli/#environment-variables-vx-reads).

## Dev tasks

A `persistent` task is a server or watcher. Its dependents start once it
prints a line matching `readyWhen`; if none comes, `exec.timeout` fails it.

```ts
// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    dev: {
      exec: { command: 'vite', persistent: { readyWhen: 'Local:' }, timeout: '30s' },
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

`.vx/workspace.ts` is required: the nearest one up from where you run,
within your git checkout, marks the workspace root (`vx init` writes
it). With no plugins in it, vx runs and caches on this machine.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'grpcs://cache.internal:443' })],
  run: {
    concurrency: 8, // default: usable cores
    timeout: '10m', // default: none
  },
  cache: {
    dir: 'build/.vx', // unset: entries shared by this repo's checkouts in ~/.vx/<id>/cache
    retention: { olderThan: '30d', maxSize: '10GB' },
  },
})
```

Settings sit in groups, `run`, `cache` and `watch`, beside `plugins`.
Each has one path, and its variable and flag come from it:
`run.timeout` is `VX_RUN_TIMEOUT` and `vx run --timeout`. A flag beats
the variable, which beats this file. Durations carry a unit (`'500ms'`,
`'30s'`, `'10m'`), sizes too (`'10GB'`). The
[settings table](../../schema/#settings) lists all of them.

| Field            | Sets                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `plugins`        | asked in order; this machine runs what they decline, and its cache is asked first ([Plugins](../plugins/)) |
| `run.concurrency` | tasks at once, a number or a share of the cores (`'50%'`) |
| `run.timeout`, `run.retries` | a task's time limit and re-runs, for tasks without their own `exec.timeout` / `exec.retries` |
| `run.affectedBase` | the git ref a bare `--affected` compares with; default `origin/HEAD`, then the first trunk (`origin/main`, `origin/master`, `main`, `master`) that is not HEAD, else `HEAD~1` |
| `run.schedule` | which ready task starts first: `'most-work'` (default, most tasks waiting behind it), `'critical-path'` (longest chain), `'direct-dependents'`, `'ready-order'`; a `schedule` plugin's weights come first ([Blog](../../blog/scheduling-strategies/#pick-the-guess)) |
| `run.rules` | graph checks, each on unless `false`: `exclusiveOutputs` refuses two tasks on one output path even when one depends on the other, `upfrontKeys` a task whose inputs can match another task's outputs, so every key is known before anything runs; `vx lock` and `vx lock --check` check them, never a run ([Schema](../../schema/#workspace-config-vxworkspacets)) |
| `cache.dir`      | keep the whole cache here, shared with no other workspace; unset, entries live in `~/.vx/<id>/cache` and every checkout of the repo hits them |
| `cache.retention` | evict at the end of every run: `olderThan` unused, then least recently used past `maxSize`; default none |
| `cache.policy` | which layers read and write (`'local:rw,remote:r'`) |
| `cache.scope` | where cache writes land: none reads and writes the default keys, a name like `'pr-123'` reads the default keys then its own and writes only its own; `cache.policy` alone decides whether a run writes; `github()` sets it on Actions ([Security](../../security/#cache-poisoning)) |
| `cache.inputStability` | every task's `cache.inputStability` default, `{ strategy, severity }`: `'immutable'` / `'warn'` unless set; a task's own field wins, the `VX_CACHE_INPUT_STABILITY_*` variables win over both ([Schema](../../schema/#cache-optional)) |
| `lock.reviewFiles` | `false` stops `vx lock` writing a pretty `vx.lock.json` (the project's resolved config, for review) beside each `vx.config` |
| `watch.poll` | `vx watch` polls instead of using the OS watcher |

For a timeout, the first one set wins: a task's `exec.timeout`, then
`--timeout`, then `VX_RUN_TIMEOUT`, then `run.timeout`. Only `exec.timeout` is in the
cache key. There is no `globalInputs`: import a shared array instead.

## Lockfiles

Without a plugin, no lockfile or `package.json` is in any task's key,
so an install re-keys nothing (an old build replays), and `^build` has no package edges: vx
reads none from a `package.json`, so it refuses a `^` and names the
plugin to add.
With `@vzn/vx-lockfile` (`bun add -d @vzn/vx-lockfile`), each package is
keyed on its own dependencies, `^build` follows what the manager
installed, and `--affected` follows both.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()], // pnpm({ scope: 'workspace' }) keys the whole file instead
})
```

| Plugin   | A package's key folds                                                                 | Install-wide, for every package |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `pnpm()` | every package it reaches, by name, version and resolved peers, with integrity and any patch | every top-level field but `importers`, `packages`, `snapshots`, `patchedDependencies`, `catalogs` and `overrides` (`settings`, `onlyBuiltDependencies`, …) |
| `bun()`  | the same, through Bun's hoisted layout                                                | every top-level field but `workspaces`, `packages`, `catalog`, `catalogs`, `overrides` and `patchedDependencies` (`trustedDependencies`, …) |
| `npm()`  | the same, from `npm-shrinkwrap.json` or `package-lock.json` versions 2 and 3                                | the `lockfileVersion`; root `overrides` reach a package through the entries they force |
| `yarn()` | the same, from a berry lockfile, each entry with every field but its dependency lists; a yarn 1 lockfile records no workspaces, so every package folds the whole file | `__metadata`'s `version` and `cacheKey`, and the root workspace's entry (its `dependenciesMeta`) through the root's closure |

Every package's key also folds the root package's own dependencies:
their bins run from the root `node_modules/.bin`, which is on every
task's PATH. So bumping a root devDependency re-runs every package.

Each plugin also folds its manager's install settings into every task
(`pnpm()`: `pnpm-workspace.yaml`, `.npmrc`; `bun()`: `bunfig.toml`,
`.npmrc`; `npm()`: `.npmrc`; `yarn()`: `.yarnrc.yml`), adds a package's
`package.json` to its cached tasks' inputs, and gives vx the project
edges the lockfile records: what `^build` waits on, and what `--filter`
and `--affected` follow. A yarn 1 lockfile records no workspaces, so
`yarn()` gives no edges there and says so.

`vx why` names the part `plugin @vzn/vx-lockfile/pnpm`. An unreadable
lockfile stops the run and names the install to re-run. An import you
never declared is in no package's key.
