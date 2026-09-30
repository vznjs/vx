---
title: Migrate
description: Run a Turborepo or Nx repo under vx with one new file, written by `vx init`, then let `bunx @vzn/vx-migrate` write vx.config.ts files when you are ready.
---

Run your Turborepo or Nx repo under vx today, and move its config to
TypeScript at your own pace. moon, wireit and lage repos are further down.

> `@vzn/vx-migrate` is not on npm yet: its first publish is pending, so
> the install in `vx init`'s `next:` line fails until then. The steps
> below are the ones to run once it is; `examples/turbo` runs them
> against this repo's packages on every commit.

## Turborepo

1. Install vx: `npm install -D @vzn/vx` (pnpm: `pnpm add -D -w @vzn/vx`).
2. Run `npx vx init`. Beside `turbo.json` or `turbo.jsonc` it writes this
   `vx.workspace.ts` and nothing else, then prints a `next:` line.
3. Run that line. It installs `@vzn/vx-migrate` with your lockfile's
   manager, then runs what `turbo run build` ran, under vx's cache.
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`. It never overwrites a file without `--force`.
5. Review each `TODO(vx-migrate)` comment. A package with its own `vx.config.ts` keeps it; `turbo()` fills only the rest.

```ts
// vx.workspace.ts, as vx init writes it
import type { WorkspaceConfig } from '@vzn/vx'
import { turbo } from '@vzn/vx-migrate'

export default { plugins: [turbo()] } satisfies WorkspaceConfig
```

```text
$ npx vx init
vx init: turbo.json found — turbo() from @vzn/vx-migrate runs this repo as it is; nothing else written.
wrote vx.workspace.ts.

next: npm install -D @vzn/vx-migrate && npx vx run build --all
```

`vx init --dry` prints the file instead of writing it. An existing
`vx.workspace.ts` that does not declare `turbo()` is left alone: add it
to the plugins, or `--force` replaces the file.

Where the repo shows a remote cache (an enabled `remoteCache` in turbo.json, or
`TURBO_TOKEN` in a CI file), the file declares `turboCache()` too.

### Try it in five minutes

[`examples/turbo`](https://github.com/vznjs/vx/tree/main/examples/turbo)
is a Turbo repo with that `vx.workspace.ts` added. Every line below is
what a test runs on each commit (`packages/vx/tests/examples.unsafe.test.ts`).

```sh
npm install && git init && git add -A && git commit -m init
npx vx run test --all      # 3 miss: lib#build, app#build, app#test
npx vx run test --all      # 3 up-to-date
bunx @vzn/vx-migrate       # 3 tasks migrated clean, 0 TODOs
git add -A && git commit -m migrate
npx vx run test --all      # 3 up-to-date: the written configs derive the same keys
rm vx.workspace.ts         # drop turbo(); the configs stand alone
git add -A && git commit -m done
npx vx run test --all      # 3 up-to-date
```

| Turborepo (`turbo.json`)                                    | vx (`vx.config.ts`)                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tasks` / `pipeline`                                        | `tasks`                                                                  |
| `dependsOn`                                                 | `dependsOn`, the same `'build'`, `'^build'`, `'pkg#build'` syntax        |
| `inputs`                                                    | `cache.inputs.files`                                                     |
| `outputs`                                                   | `cache.outputs.files`                                                    |
| `env`                                                       | `cache.inputs.env` **and** `exec.env.passThrough`                        |
| `passThroughEnv`                                            | `exec.env.passThrough`                                                   |
| `cache: false`                                              | no `cache` block: the task always runs                                   |
| `persistent: true`                                          | `exec.persistent: { … }`                                                 |
| `with` | `dependsOn` a persistent sidecar, started beside the task |
| `interruptible` | nothing: `vx watch` re-spawns every persistent task each cycle |
| `outputLogs`                                                | `"new-only"` is the default; other values are the run's `--output-logs` |
| `dotEnv` (Turbo 1), a `.env` input                          | `cache.inputs.runtime`: a probe that prints every `.env` file's name and bytes, because a gitignored `.env` is invisible to a git glob; a root one (`$TURBO_ROOT$/.env`, `globalDotEnv`) is `cache.inputs.workspaceRuntime` |
| `command` (Turbo 2.11) | `exec.command` (the argv, quoted); `null` or `[]` is no task |
| `description` | `description` |
| `extends`                                                   | nothing: a package task merges over the root's, field by field           |
| `$TURBO_ROOT$/file`                                         | `cache.inputs.workspaceFiles` / `outputs.workspaceFiles`                 |
| `globalDependencies` / `globalEnv` / `globalPassThroughEnv` (and Turbo 1's `globalDotEnv`) | a generated `vx-preset.ts` you import; a wildcard env name is reported, not mapped |

The command itself comes from your `package.json` script, with its
`pre<name>` / `post<name>` hooks folded in.

| Turborepo                         | vx                                                     |
| --------------------------------- | ------------------------------------------------------ |
| `turbo run build`                 | `vx run build --all`                                   |
| `turbo run build --filter=@app/*` | `vx run build --filter "@app/*"`                       |
| `turbo run build --affected`      | `vx run build --affected`                              |
| `turbo run build --continue`      | `vx run build --continue` (the default is `deps-ok`)   |
| `TURBO_TOKEN` remote cache        | [`turboCache()`](../ci/#remote-cache) reads the same variables |

## Nx

1. Install vx: `npm install -D @vzn/vx` (pnpm: `pnpm add -D -w @vzn/vx`).
2. Run `npx vx init`. Beside `nx.json` it writes this `vx.workspace.ts`
   and nothing else. With `turbo.json` there too, it declares `turbo()`.
   A CI file that names `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` adds `nxCache()`.
3. Run the `next:` line it prints. It installs `@vzn/vx-migrate`, then
   runs what `nx run-many -t build` ran, under vx's cache.
4. Write the resolved graph: `nx graph --file=.nx/workspace-data/project-graph.json`. `vx-migrate` reads it and never guesses from `nx.json`.
5. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`.

```ts
// vx.workspace.ts, as vx init writes it
import type { WorkspaceConfig } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default { plugins: [nx()] } satisfies WorkspaceConfig
```

Executor targets keep running as executors. Each becomes one `nx-exec`
line, which runs the executor through Nx's public `runExecutor`, with its
options on the command line so the cache key sees them:

```bash
nx-exec @nx/js:tsc --project lib --target build --options '{"main":"src/index.ts","tsConfig":"tsconfig.lib.json"}'
```

Replace each with the command the executor wraps when you want to drop
Nx; until the last one is gone, keep `nx` and `@vzn/vx-migrate`
installed.

| Nx                                   | vx                                                        |
| ------------------------------------ | --------------------------------------------------------- |
| a project's `targets`                | `tasks`                                                   |
| `dependsOn` (`^build`, `app:build`)  | `dependsOn` (`^build`, `app#build`)                       |
| `configurations`                     | one task per configuration: `build`, `build:ci`           |
| `inputs` / `namedInputs`             | `cache.inputs.files`                                      |
| `{workspaceRoot}/file`               | `cache.inputs.workspaceFiles`                             |
| `{ "env": "VAR" }`                   | `cache.inputs.env` **and** `exec.env.passThrough`         |
| `{ "runtime": "<cmd>" }`             | `cache.inputs.workspaceRuntime`: it runs at the workspace root, as Nx's does |
| `{ "json": "<file>", "fields": … }`  | the whole file in `files` / `workspaceFiles`: a superset of the fields |
| `outputs`                            | `cache.outputs.files` (or `workspaceFiles` for `dist/<project>`) |
| `nx build app`                       | `vx run app#build`                                        |
| `nx run app:build:production`        | `vx run app#build:production`                             |
| `nx affected -t test`                | `vx run test --affected`                                  |
| `nx graph`                           | `vx run build --all --graph`                              |
| `nx reset`                           | nothing: there is no daemon                               |
| Nx Cloud cache                       | [`nxCache()`](../ci/#remote-cache) for a self-hosted Nx cache |

Generators, Nx Console and module-boundary rules have no vx equivalent;
keep Nx for those.

## moon

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add this `vx.workspace.ts`. It is the only new file.
3. Run `vx run build --all`. It runs what `moon run :build` ran, under vx's cache.
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { moon } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [moon()] })
```

vx runs the projects your package manager's workspaces list; a moon
project with no `package.json` there is reported, not run.

| moon                                   | vx                                                     |
| -------------------------------------- | ------------------------------------------------------ |
| `.moon/tasks.yml`, `.moon/tasks/*.yml` | inherited as moon inherits them (by name, or `inheritedBy`) |
| `command` + `args`                     | `exec.command`                                         |
| `deps`: `^:build`, `app:build`         | `dependsOn`: `^build`, `app#build`                     |
| `inputs` (none: every project file)    | `cache.inputs.files`                                   |
| `@group(sources)`                      | the file group's entries                               |
| `/tsconfig.json`                       | `cache.inputs.workspaceFiles`                          |
| `$VAR` input                           | `cache.inputs.env` **and** `exec.env.passThrough`      |
| `outputs`                              | `cache.outputs.files`                                  |
| `options.cache: false`                 | no `cache` block                                       |
| `local: true`, `preset: server`        | `exec.persistent: {}`                                  |
| `moon run app:build`                   | `vx run app#build`                                     |
| `moon run :build --affected`           | `vx run build --affected`                              |

The full table and what is not mapped: the
[`@vzn/vx-migrate` README](https://github.com/vznjs/vx/tree/main/packages/vx-migrate#moon--run-a-moon-workspace-unchanged).

## wireit

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add this `vx.workspace.ts`. It is the only new file.
3. Run `vx run build --all`. It runs each package's `wireit.build`, under vx's cache.
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { wireit } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [wireit()] })
```

| wireit                         | vx                                                |
| ------------------------------ | ------------------------------------------------- |
| `command`                      | `exec.command`                                    |
| `dependencies`: `../pkg:build` | `dependsOn`: `pkg#build`                          |
| `files` + `output`             | `cache.inputs.files` + `cache.outputs.files`      |
| `env`: `{ "external": true }`  | `cache.inputs.env` **and** `exec.env.passThrough` |
| `service`                      | `exec.persistent` (with `readyWhen`)              |
| `npm run build`                | `vx run build`                                    |

The full table: the
[`@vzn/vx-migrate` README](https://github.com/vznjs/vx/tree/main/packages/vx-migrate#wireit--run-a-wireit-workspace-unchanged).

## lage

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add this `vx.workspace.ts`. It is the only new file.
3. Run `vx run build --all`. It runs what `lage build` ran, under vx's cache.
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { lage } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [lage()] })
```

| lage                                | vx                                                 |
| ----------------------------------- | -------------------------------------------------- |
| `pipeline.build: ['^build']`        | `dependsOn: ['^build']`                            |
| `^^transpile`                       | a `pkg#transpile` edge per transitive dependency   |
| `inputs` / `outputs`                | `cache.inputs.files` / `cache.outputs.files`       |
| `cacheOptions.environmentGlob`      | `cache.inputs.workspaceFiles`                      |
| `type: 'noop'`                      | a group task                                       |
| `type: 'worker'` | a `lage-worker` line: the module, one process |
| `lage build --to app`               | `vx run app#build`                                 |

A target with no `outputs` and no `cacheOptions.outputGlob` runs
uncached: lage would cache every package file, and vx cleans outputs
before a run. The full table: the
[`@vzn/vx-migrate` README](https://github.com/vznjs/vx/tree/main/packages/vx-migrate#lage--run-a-lage-workspace-unchanged).

## pnpm, npm, yarn or bun workspaces

A root `package.json` that runs `pnpm -r build`, `npm run test --workspaces`
or `yarn workspaces foreach -t run build` runs under vx with
`workspaceScripts()`:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { workspaceScripts } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [workspaceScripts()] })
```

| Root script                              | vx                                            |
| ---------------------------------------- | --------------------------------------------- |
| `pnpm -r --filter './packages/*' build`  | `build` in those packages, after `^build`     |
| `pnpm -r --parallel dev`                 | `dev` in each package, persistent, no edges   |
| `pnpm -r build && pnpm -r test`          | `test` after its package's `build`            |
| `pnpm build`                             | `vx run build --all`                          |
| `"build:examples": "pnpm -F '@example/*' build"` | noted as `vx run build --filter '@example/*'` |

Nothing is cached until a package's `vx.config.ts` declares its inputs and
outputs. With no fan-out scripts at all, `vx init` writes the configs.

## Common problems

- **No workspace root.** vx finds projects through `pnpm-workspace.yaml` or `package.json` `workspaces`. A moon repo without either needs a root `package.json` listing its projects; a Rush repo (`rush.json`) is not supported yet.
- **A task always runs.** vx caches only a task with a `cache` block. `vx-migrate` fills it from `turbo.json`, the Nx graph, `.moon/`, wireit scripts or `lage.config.js`.
- **An env var is missing in the command.** vx isolates the environment: list it in `exec.env.passThrough` ([Environment variables](../configure/#environment-variables)).
- **`vx run build` ran one package.** Without `--all`, vx runs the package you are in.

Every Turborepo and Nx behaviour, spelled in vx and pinned by a test: the
[parity map](../../parity/).
