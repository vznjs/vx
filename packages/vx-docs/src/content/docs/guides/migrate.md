---
title: Migrate
description: Move a Turborepo or Nx repo to native vx config with one command, `vx init`.
---

Run `npx @vzn/vx init` at the repo root. Beside `turbo.json` or
`nx.json` it writes the native `vx.config.ts` files you keep; vx's
benchmarks measure only that native config. Any other repo starts the
same way, at the [quickstart](../../quickstart/).

> `examples/turbo` runs the steps below against this repo's packages on
> every commit.

## One command

`npx @vzn/vx init` is the whole adoption in a Turbo or Nx repo: beside
`turbo.json` or `nx.json` it runs `@vzn/vx-migrate` (the latest
release, which installs the latest `@vzn/vx` and moves every `@vzn/vx-*` plugin
the repo lists or the workspace file imports with it). It asks whether to migrate natively (a `vx.config.ts` per
package, the default) or keep `turbo.json` / `nx.json` as the source
(`turbo()` / `nx()`, see [Check the mapping first](#check-the-mapping-first)); `--native` or `--keep` answer it, and
without a terminal, or from Vite Task, it is native. It installs vx with the repo's own package
manager and declares the plugins the repo calls for in `.vx/workspace.ts`:
the lockfile's `@vzn/vx-lockfile` plugin (`pnpm()`, …), `scheduleHistoryPlugin()`,
and `github()` when `.github/workflows` exists, installing each beside vx at
the same version (`--no-install` leaves `package.json` alone). Your
`package.json` scripts stay as they are.

pnpm 12 refuses a version published within its `minimumReleaseAge`,
and vx releases daily. If an install stops on that, list the `@vzn/*`
packages it names under `minimumReleaseAgeExclude` in
`pnpm-workspace.yaml`, or install the previous version; vx-migrate's
error names the same fix.

## Turborepo

1. Run `npx @vzn/vx init`; it installs vx globally and in the repo. Beside `turbo.json` or `turbo.jsonc` it writes
   one `vx.config.ts` per package (plus a `vx-preset.ts` when turbo.json
   has global fields or a task `env` several packages share), a
   `.vx/workspace.ts` declaring your lockfile's plugin, and
   `.vx/projects.lock.json`. It never overwrites a file without `--force`.
2. Review each `TODO(vx-migrate)` comment.
3. Once `vx run build --all` does what `turbo run build` did, delete
   `turbo.json`: the configs declare every task it mapped.

### Check the mapping first

`npx @vzn/vx init --keep` writes only this `.vx/workspace.ts` (and
`.vx/.gitignore`, which keeps `.vx/cache` and `.vx/tmp` out of git), installs what it
imports with your lockfile's manager (`@vzn/vx-migrate`, and
`@vzn/vx-lockfile` for your lockfile's plugin: `npm()`, `pnpm()`, `bun()`
or `yarn()`), and writes the lock. Its `next:` line builds once through
`turbo()`: a check that the mapping holds before you write configs, not a
way to keep running the repo. `bunx @vzn/vx-migrate --dry` then previews
the configs and `bunx @vzn/vx-migrate` writes them, takes `turbo()` out of
`.vx/workspace.ts` and uninstalls `@vzn/vx-migrate` unless a
`turboCache()` still needs it.

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { turbo } from '@vzn/vx-migrate'
import { npm } from '@vzn/vx-lockfile'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default {
  plugins: [
    turbo(),
    npm(),
    scheduleHistoryPlugin(),
  ],
} satisfies WorkspaceConfig
```

```text
$ npx @vzn/vx init --keep

─ vx-migrate 0.0.637 ─────────────────────────────────────────
  from      turbo.json, run by turbo() from @vzn/vx-migrate
  ran       npm install -D @vzn/vx-lockfile @vzn/vx-schedule-history
  files     .vx/workspace.ts
  lock      0 project configs → .vx/projects.lock.json (no vx.config, so not locked: app, lib)
  note      a temporary start: vx init --native writes native config

  next      npx @vzn/vx run build --all
```

The install uses your lockfile's manager (`pnpm add -D -w …` beside
`pnpm-lock.yaml`, `yarn add -D -W …` beside a Yarn 1 lockfile) and adds what is not installed at the latest release yet, with every
`@vzn/vx-*` plugin the root lists or `.vx/workspace.ts` imports: every `@vzn` package releases in lockstep.
`--no-install` skips it, and the `next:` line names it instead.
`vx init --keep --dry` prints the file instead of writing it; `--mjs` writes
`.vx/workspace.mjs` without the type import. An existing
`.vx/workspace.ts` that does not declare `turbo()` is left alone: add it
to the plugins, or `--force` replaces the file.

Where the repo shows a remote cache (an enabled `remoteCache` in
turbo.json, a `.turbo/config.json` that `turbo link` wrote, or
`TURBO_TOKEN` set in a GitHub Actions, GitLab or CircleCI file), the file
declares `turboCache()` too, and init says why:

```text
turboCache(): .github/workflows/ci.yml sets TURBO_TOKEN, so vx shares that remote cache (token: the variable, else the OS keychain).
```

`bunx @vzn/vx-migrate`, like `vx init`, reports what it wrote, then locks the configs:

```text
$ bunx @vzn/vx-migrate

─ vx-migrate 0.0.637 ─────────────────────────────────────────
  from      turbo.json
  config    dropped turbo() from .vx/workspace.ts
  ran       npm uninstall @vzn/vx-migrate
  tasks     3 clean
  files     packages/app/vx.config.ts
            packages/lib/vx.config.ts
  lock      2 project configs → .vx/projects.lock.json

  next      bunx @vzn/vx run build --all
```

The first run after it misses every task once: the lockfile plugin it
declared, and the install, change each key (`vx why <task>` names both).
The run after that hits. The example below keeps its own
`.vx/workspace.ts` and installs nothing, so it hits at once.

`packages/lib/vx.config.ts`, as written:

```ts
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      exec: {
        command: 'mkdir -p dist && cp src/*.js dist/',
      },
      dependsOn: ['^build'],
      inputs: {
        files: ['src/**'],
      },
      cache: {
        outputs: {
          files: ['dist/**'],
        },
      },
    },
  },
} satisfies ProjectConfig
```

Where the repo has a lockfile and `.vx/workspace.ts` declares no
`@vzn/vx-lockfile` plugin, the report names the one for it (`npm()` above,
`pnpm()` for `pnpm-lock.yaml`): Turbo keys each package on its own lockfile entries,
and vx keys every task on the whole file until a plugin claims it. The
plugin is also where `^build` gets its package edges: vx reads none from
a `package.json`, and refuses a `^` with no plugin that supplies them.

### Try it in five minutes

[`examples/turbo`](https://github.com/vznjs/vx/tree/main/examples/turbo)
is a Turbo repo with that `.vx/workspace.ts` added, and the
`.vx/projects.lock.json` `vx lock` wrote (a run refuses without one). The first runs go
through `turbo()`, the bridge; the last runs on the written configs alone,
the goal. Each line and its comment is what a test runs and sees on each commit
(`packages/vx/tests/examples.unsafe.test.ts`).

```sh
npm install && git init && git add -A && git commit -m init
npx @vzn/vx run test --all      # local 3↑: lib#build, app#build, app#test
npx @vzn/vx run test --all      # local 3✓
bunx @vzn/vx-migrate       # tasks 3 clean
git add -A && git commit -m migrate
npx @vzn/vx run test --all      # local 3✓: the written configs derive the same keys
echo "import { npm } from '@vzn/vx-lockfile'; export default { plugins: [npm()] }" > .vx/workspace.ts   # drop turbo(); npm() keeps the edges
git add -A && git commit -m done
npx @vzn/vx run test --all      # local 3✓
```

| Turborepo (`turbo.json`)                                    | vx (`vx.config.ts`)                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tasks` / `pipeline`                                        | `tasks`                                                                  |
| `dependsOn`                                                 | `dependsOn`, the same `'build'`, `'^build'`, `'pkg#build'` syntax        |
| `inputs`                                                    | `inputs.files`; a glob that reaches a nested workspace package also in `inputs.workspaceFiles` |
| `outputs`                                                   | `cache.outputs.files`, plus the `.tsbuildinfo` a `tsc -b` writes outside them |
| `env`                                                       | `inputs.env` **and** `exec.env.passThrough`                        |
| `passThroughEnv`                                            | `exec.env.passThrough`                                                   |
| `cache: false`                                              | no `cache` block: the task always runs, keyed on its `inputs`            |
| `persistent: true`                                          | `exec.persistent: { … }`                                                 |
| `with` | `dependsOn` a persistent sidecar, started beside the task |
| `interactive: true` | `exec.interactive: true`: the task gets the terminal, alone |
| `interruptible` | nothing: `vx watch` keeps a persistent task up and restarts it only when its config changes or it dies |
| `tags` | nothing: labels Turbo keeps out of the hash and the behaviour |
| `outputLogs` (Turbo 1: `outputMode`)                        | `"new-only"` is the default; other values are the run's `--output-logs` |
| `dotEnv` (Turbo 1), a `.env` input                          | `inputs.runtime`: a probe that prints every `.env` file's name and bytes, because a gitignored `.env` is invisible to a git glob (written configs name it from the preset: `dotenvFiles`, `dotenvFilesDeep`, and `dotenvRootFiles` for the root globs); a root one (`$TURBO_ROOT$/.env`, `globalDotEnv`) is `inputs.workspaceRuntime`, a probe of just the files its globs name |
| an input or `globalDependencies` path git ignores (`config.local.json`) | `inputs.workspaceRuntime`: a probe that prints the file's name and bytes, since core refuses a file input git ignores; a gitignored file a glob matches is not keyed |
| `command` (Turbo 2.11) | `exec.command` (the argv, quoted); `null` or `[]` is no task |
| `description` | `description` |
| `extends`                                                   | nothing: a package task merges over the root's, field by field           |
| `$TURBO_ROOT$/file`                                         | `inputs.workspaceFiles` / `outputs.workspaceFiles`                 |
| `globalDependencies` / `globalEnv` / `globalPassThroughEnv` (and Turbo 1's `globalDotEnv`) | a generated `vx-preset.ts` each config imports as `vx-preset.js` (your `tsc` accepts it without `allowImportingTsExtensions`; Bun loads the `.ts`), except where a `tsconfig*.json` in the config's directory or above it (below the root) is a composite project or sets `rootDir` and takes the config in: there the config declares the values itself, as `tsc` refuses a file outside the package (TS6059); a wildcard env name is reported, not mapped |

The command itself comes from your `package.json` script, with its
`pre<name>` / `post<name>` hooks folded in.

| Turborepo                         | vx                                                     |
| --------------------------------- | ------------------------------------------------------ |
| `turbo run build`                 | `vx run build --all`                                   |
| `turbo run build --filter=@app/*` | `vx run build --filter "@app/*"`                       |
| `turbo run build --affected`      | `vx run build --affected` (`turbo()` takes `TURBO_SCM_BASE`, or GitHub Actions' base, as Turbo does) |
| `turbo run build --continue`      | `vx run build --continue` (`always`, as Turbo's; without it, vx skips only a failure's dependents where Turbo stops) |
| `TURBO_TOKEN` remote cache        | [`turboCache()`](../ci/#remote-cache) reads the same variables |

## Nx

1. Run `npx @vzn/vx init`; it installs vx globally and in the repo. Beside `nx.json` it writes one
   `vx.config.ts` per project, a `.vx/workspace.ts` declaring your
   lockfile's plugin, and `.vx/projects.lock.json`. With `turbo.json`
   there too, run `bunx @vzn/vx-migrate --from nx` (or `--from turbo`)
   instead. A CI file that sets `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` adds
   `nxCache()`; an Nx Cloud workspace is named instead, since vx cannot
   share its cache.
2. It reads the resolved graph, never `nx.json` alone: an exported
   `.nx/workspace-data/project-graph.json`, else the one your installed
   `nx` exports for it (`nx graph`). Without `nx` installed it stops and
   prints the export command.
3. Review each `TODO(vx-migrate)` comment, and rewrite each `nx-exec`
   line (an executor target) as the command it runs.
4. Once `vx run build --all` does what `nx run-many -t build` did,
   delete `nx.json`: the configs declare every task the graph had. Keep
   Nx installed while a config still runs an `nx-exec` line.

To check the mapping first, `npx @vzn/vx init --keep` writes only this
`.vx/workspace.ts` (and `.vx/.gitignore`), installs what it imports
(`@vzn/vx-migrate`, `@vzn/vx-lockfile`) and writes the lock; its `next:`
line builds once through `nx()`. `bunx @vzn/vx-migrate` then writes the configs, takes `nx()` out
of `.vx/workspace.ts` and uninstalls `@vzn/vx-migrate` unless a written
task runs an `nx-exec` or `nx-env` line, or `nxCache()` needs it.

A Lerna 6+ repo whose root scripts call `lerna run` runs on Nx's task
runner, `nx.json` or not, so `bunx @vzn/vx-migrate` maps it as an Nx repo
from the graph `nx graph` exports; so does `vx init`, which runs it.

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

```text
$ npx @vzn/vx init --keep

─ vx-migrate 0.0.637 ─────────────────────────────────────────
  from      nx.json, run by nx() from @vzn/vx-migrate
  ran       npm install -D @vzn/vx-lockfile @vzn/vx-schedule-history
  files     .vx/workspace.ts
            .vx/.gitignore
  lock      0 project configs → .vx/projects.lock.json (no vx.config, so not locked: app, lib)
  note      a temporary start: vx init --native writes native config

  next      npx @vzn/vx run build --all
```

`bunx @vzn/vx-migrate`, like `vx init`, reports what it wrote, then locks the configs:

```text
$ bunx @vzn/vx-migrate

─ vx-migrate 0.0.637 ─────────────────────────────────────────
  from      nx graph
  config    dropped nx() from .vx/workspace.ts
  ran       npm uninstall @vzn/vx-migrate
  tasks     2 clean
  files     packages/app/vx.config.ts
            packages/lib/vx.config.ts
  lock      2 project configs → .vx/projects.lock.json
  note      migrating from the resolved project-graph snapshot — plugin-inferred targets are frozen as static config; `nx:run-commands` targets are their shell lines, and every other executor runs as itself through `nx-exec` (keep Nx and @vzn/vx-migrate installed until those targets are rewritten as commands); targets with `.env` files run through `nx-env`

  next      bunx @vzn/vx run build --all
```

`packages/lib/vx.config.ts`, as written (the `define` names are the
ones Nx sets for a task):

```ts
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      exec: {
        command: 'mkdir -p dist && cp src/index.js dist/lib.js',
        env: {
          define: {
            NX_TASK_TARGET_PROJECT: 'lib',
            NX_TASK_TARGET_TARGET: 'build',
            LERNA_PACKAGE_NAME: 'lib',
          },
        },
      },
      inputs: {
        files: ['src/**/*'],
      },
      cache: {
        outputs: {
          files: ['dist'],
        },
      },
    },
  },
} satisfies ProjectConfig
```

An executor target is written as an `nx-exec` line: the executor runs
as itself, in its own Node process through Nx's public `runExecutor`,
with its options on the command line, as `nx()` runs it. The migrator
translates no executor; `nx:run-commands` targets are their shell
lines, `nx:run-script` the package script, and `nx:noop` a group task.
Rewriting each `nx-exec` line as the command the executor wraps (jest,
`vite build`, `tsc -p …`) is the step that lets you remove Nx:

```ts
test: { exec: { command: `nx-exec @nx/jest:jest --project a --target test --options '{"jestConfig":"libs/a/jest.config.ts"}'` } }
```

| Nx                                   | vx                                                        |
| ------------------------------------ | --------------------------------------------------------- |
| a project's `targets`                | `tasks`                                                   |
| `dependsOn` (`^build`, `app:build`)  | `dependsOn` (`^build`, `app#build`)                       |
| `configurations`                     | one task per configuration: `build`, `build:ci`           |
| `inputs` / `namedInputs`             | `inputs.files`                                      |
| `{workspaceRoot}/file`               | `inputs.workspaceFiles`                             |
| `{ "env": "VAR" }`                   | `inputs.env` **and** `exec.env.passThrough`         |
| `{ "runtime": "<cmd>" }`             | `inputs.workspaceRuntime`: it runs at the workspace root, as Nx's does |
| `{ "json": "<file>", "fields": … }`  | the whole file in `files` / `workspaceFiles`: a superset of the fields |
| `outputs`                            | `cache.outputs.files` (or `workspaceFiles` for `dist/<project>`) |
| `nx build app`                       | `vx run app#build`                                        |
| `nx run app:build:production`        | `vx run app#build:production`                             |
| `nx affected -t test`                | `vx run test --affected` (`nx()` takes `NX_BASE` or `defaultBase` as its base) |
| `nx graph`                           | `vx run build --all --dry=json` (tasks and their deps)    |
| `nx reset`                           | `vx cache clean` clears it all; `--older-than <age>` trims it; there is no daemon |
| Nx Cloud cache                       | [`nxCache()`](../ci/#remote-cache) for a self-hosted Nx cache |

Generators, Nx Console and module-boundary rules have no vx equivalent;
keep Nx for those.

## Vite Task

`npx @vzn/vx-migrate` in a repo whose root `package.json` lists
`vite-plus` writes a `vx.config.ts` per package from each `vite.config`
`run.tasks` and its `package.json` scripts (`--from vite-task` when
turbo.json or Nx is there too). Vite Task traces the files a task reads
and writes; vx declares them, so a task without explicit `cache.input`
and `cache.output` runs uncached until its `TODO(vx-migrate)` is filled.
The field-by-field mapping is in the `@vzn/vx-migrate` README.

## Common problems

- **A project is missing.** A project is a directory holding a `vx.config.ts`, which `vx lock` finds; `bunx @vzn/vx-migrate` writes one for every project. Mid-migration, `turbo()` and `nx()` make each package in `pnpm-workspace.yaml` or `package.json` `workspaces` a project, and `nx()` adds each Nx project the graph names that no package glob lists (a `project.json` library, the root project). `bunx @vzn/vx-migrate` writes a `package.json` for each such library that lacks one and prints the directories to add to the globs. A repo with no `package.json` (Nx in `.nx/installation`) gets no `package.json` anywhere: each `vx.config.ts` names its project and lists its edges explicitly.
- **A task always runs.** vx caches only a task with a `cache` block. `vx-migrate` fills it from `turbo.json` or the Nx graph; a Turbo task with `cache: false` has none.
- **An env var is missing in the command.** vx isolates the environment: list it in `exec.env.passThrough` ([Environment variables](../configure/#environment-variables)).
- **`vx run build` ran one package.** Without `--all`, vx runs the package you are in.

Every Turborepo and Nx behaviour, spelled in vx and pinned by a test: the
[parity map](../../parity/).
