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
A package that declares no `build` gets a default one: a group behind
`^build`, keyed on all its files, so editing a package consumed as source
re-runs its dependents (`vx show` marks it `default build`). A cycle or a
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
| Always in it           | the package's `package.json`, the lockfile, the keys of the tasks it depends on, the task's config, arguments after `--` |
| Always excluded        | an untracked `node_modules` (an install), `.git`, `.vx`, `*.tsbuildinfo`, `vx-lock.json`, `*.bun-build`, `.????????????????-????????.tmp` (Bun's compile scratch), files git ignores, the task's own outputs, a nested project's files |
| Out, when you say so   | a dependency only for order: `cache.inputs.tasks: []`, as the [dev task](#dev-tasks) does |

Declared outputs are wiped before every run that writes the cache and every
restore, so `dist/`
ends as the cache stored it; a hit that finds them already as stored skips
both. A task that adds files beside an upstream task's outputs wipes
nothing before a run and only the files it recorded before a restore. A failed task is never saved. `--force` runs
and refreshes the cache; `--no-cache` ignores it.

A fully cached 3,270-task run: vx 393ms, Turborepo 463ms (vx 1.1× faster),
Nx 6.45s (vx 16× faster)
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
| `cache key unchanged — re-executed because this run did not read the cache (--force, or a --cache without read)` | the run's policy read no cache |
| `cache key unchanged — neither run saved it: each ran beside a failed task (…), and a task run past a failed dependency (--continue) is never cached` | both runs went past a failure under `--continue` |
| `cache key unchanged — no entry for this key was in the cache when it ran (pruned or evicted), so it executed and saved one` | the entry was gone |
| `cache key unchanged — the previous run on this key executed but no entry for it is in the cache (its save failed, or it was pruned since), so there was nothing to hit` | the previous run's save failed, or a prune took the entry |
| `cache key unchanged — the previous run on this key did not write the cache (--no-cache, or a --cache without write), so there was nothing to hit` | the previous run's policy wrote no cache |
| `cache key unchanged — re-executed on the same key though this run read the cache; vx cannot name the cause` | none of the above; vx cannot name the cause |
| `cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)` | no invocation recorded this run's cache policy, so vx cannot rule the flags out |
| `cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown` | vx does not guess |
| `` this task declares no `cache` block — it runs on every invocation; its key is folded by dependents only `` | not cached at all |
| `this task recorded no cache key (skipped, or a persistent task) — nothing to compare` | no key to compare |

A hit after you changed something means that something is not declared.

## Environment variables

Past a small essential allowlist (below), a task sees only the variables you pass it:

| List                   | The command sees it | The key sees it | Use it for                                          |
| ---------------------- | ------------------- | --------------- | --------------------------------------------------- |
| `exec.env.passThrough` | yes                 | no              | secrets and CI flags (`GITHUB_ACTIONS`, `GH_TOKEN`); stays on this machine |
| `cache.inputs.env`     | no                  | yes             | with `passThrough`: a variable that changes the output |
| `exec.env.define`      | yes                 | yes             | a literal value; a remote task gets it too          |

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
import { defineWorkspace } from '@vzn/vx/config'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'grpcs://cache.internal:443' })],
  concurrency: 8,            // default: the cores this process may use
  cacheDir: 'build/.vx',     // unset: entries shared by this repo's checkouts in ~/.vx/<id>/cache
  timeout: 600_000,
  cacheRetention: { olderThan: '30d', maxSize: '10G' },
})
```

| Field            | Sets                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `plugins`        | asked in order; this machine is always last ([Plugins](../plugins/)) |
| `concurrency`    | tasks at once; `--concurrency <n>` overrides it for one run           |
| `cacheDir`       | keep the whole cache here, shared with no other workspace; unset, entries live in `~/.vx/<id>/cache` and every checkout of the repo hits them |
| `timeout`        | a default task timeout in ms; default none                            |
| `cacheRetention` | evict at the end of every run: `olderThan` unused, then least recently used past `maxSize`; default none |
| `affectedBase` | the git ref a bare `--affected` compares with; default `origin/HEAD`, then the first trunk (`origin/main`, `origin/master`, `main`, `master`) that is not HEAD, else `HEAD~1` |
| `cacheScope` | where remote writes land: `'trusted'` reads and writes (the default on CI), `'read-only'` writes nothing (the default off CI), a name like `'pr-123'` reads its own then trusted and writes only its own; `github()` sets it on Actions ([Security](../../security/#cache-poisoning)) |
| `rules` | graph checks, each on unless `false`: `exclusiveOutputs` refuses two tasks on one output path even when one depends on the other, `upfrontKeys` a task whose inputs can match another task's outputs, so every key is known before anything runs ([Schema](../../schema/#workspace-config-vxworkspacets)) |

For a timeout, the first one set wins: a task's `exec.timeout`, then
`--timeout <ms>`, then `VX_TASK_TIMEOUT`, then this. Only `exec.timeout` is in the
cache key. There is no `globalInputs`: import a shared array instead.

## Lockfiles

Without a plugin, the lockfile is in every task's key, so one install
re-runs everything. With `@vzn/vx-lockfile` (`bun add -d @vzn/vx-lockfile`),
each package is keyed on its own dependencies, and `--affected` follows.

```ts
// vx.workspace.ts
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
| `npm()`  | the same, from `package-lock.json` versions 2 and 3                                   | the root package's `overrides` |
| `yarn()` | the same, from a berry lockfile, each entry with every field but its dependency lists; a yarn 1 lockfile records no workspaces, so every package folds the whole file | `__metadata`, and the root workspace's entry (its `dependenciesMeta`) through the root's closure |

Every package's key also folds the root package's own dependencies:
their bins run from the root `node_modules/.bin`, which is on every
task's PATH. So bumping a root devDependency re-runs every package.

`vx why` names the part `plugin @vzn/vx-lockfile/pnpm`. An unreadable
lockfile stops the run and names the install to re-run. An import you
never declared is in no package's key.
