---
title: Migrate
description: Run a Turborepo or Nx repo under vx with one new file, written by `vx init`, then let `bunx @vzn/vx-migrate` write vx.config.ts files when you are ready.
---

Run your Turborepo or Nx repo under vx today, and move its config to
TypeScript at your own pace. Any other repo starts at the
[quickstart](../../quickstart/): there `vx init` writes the configs from
your `package.json` scripts.

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
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them
   with `bunx @vzn/vx-migrate`: one `vx.config.ts` per package, plus a
   `vx-preset.ts` when turbo.json has global fields or a task `env` several
   packages share. It never overwrites a
   file without `--force`.
5. Review each `TODO(vx-migrate)` comment. A task a package's own
   `vx.config.ts` declares wins; `turbo()` fills only the rest.
6. Once `vx run build --all` does what `turbo run build` did, remove
   `turbo()` and its import from `vx.workspace.ts`, then delete
   `turbo.json`: the configs declare every task it mapped, and the
   migrator's `note:` says so while `turbo()` is still there.

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { turbo } from '@vzn/vx-migrate'

export default { plugins: [turbo()] } satisfies WorkspaceConfig
```

```text
$ npx vx init
vx init: turbo.json found — turbo() from @vzn/vx-migrate runs this repo as it is; nothing else written.
wrote vx.workspace.ts.

next: npm install -D @vzn/vx-migrate && npx vx run build --all
```

The `next:` line uses your lockfile's manager (`pnpm add -D -w …` beside
`pnpm-lock.yaml`, `yarn add -D -W …` beside a Yarn 1 lockfile) and names only what is not installed yet.
`vx init --dry` prints the file instead of writing it; `--mjs` writes
`vx.workspace.mjs` without the type import. An existing
`vx.workspace.ts` that does not declare `turbo()` is left alone: add it
to the plugins, or `--force` replaces the file.

Where the repo shows a remote cache (an enabled `remoteCache` in
turbo.json, a `.turbo/config.json` that `turbo link` wrote, or
`TURBO_TOKEN` set in a GitHub Actions, GitLab or CircleCI file), the file
declares `turboCache()` too, and init says why:

```text
turboCache(): .github/workflows/ci.yml sets TURBO_TOKEN, so vx shares that remote cache (inert where the variable is unset).
```

`bunx @vzn/vx-migrate` reports what it wrote:

```text
$ bunx @vzn/vx-migrate
vx-migrate: turbo.json → vx.config.ts
note: vx.workspace.ts still declares turbo(), which reads turbo.json every run and fills any task a vx.config does not declare; the configs written here declare them all. Once `vx run` does what turbo did, remove turbo() (and its import), then turbo.json

3 tasks migrated clean, 0 TODOs
files written:
  packages/app/vx.config.ts
  packages/lib/vx.config.ts

next: bunx vx run build --all
```

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
| `tags` | nothing: labels Turbo keeps out of the hash and the behaviour |
| `outputLogs`                                                | `"new-only"` is the default; other values are the run's `--output-logs` |
| `dotEnv` (Turbo 1), a `.env` input                          | `cache.inputs.runtime`: a probe that prints every `.env` file's name and bytes, because a gitignored `.env` is invisible to a git glob; a root one (`$TURBO_ROOT$/.env`, `globalDotEnv`) is `cache.inputs.workspaceRuntime`, a probe of just the files its globs name |
| an input or `globalDependencies` path git ignores (`config.local.json`) | `cache.inputs.workspaceRuntime`: a probe that prints the file's name and bytes, since core refuses a file input git ignores; a gitignored file a glob matches is not keyed |
| `command` (Turbo 2.11) | `exec.command` (the argv, quoted); `null` or `[]` is no task |
| `description` | `description` |
| `extends`                                                   | nothing: a package task merges over the root's, field by field           |
| `$TURBO_ROOT$/file`                                         | `cache.inputs.workspaceFiles` / `outputs.workspaceFiles`                 |
| `globalDependencies` / `globalEnv` / `globalPassThroughEnv` (and Turbo 1's `globalDotEnv`) | a generated `vx-preset.ts` each config imports as `vx-preset.js` (your `tsc` accepts it without `allowImportingTsExtensions`; Bun loads the `.ts`); a wildcard env name is reported, not mapped |

The command itself comes from your `package.json` script, with its
`pre<name>` / `post<name>` hooks folded in.

| Turborepo                         | vx                                                     |
| --------------------------------- | ------------------------------------------------------ |
| `turbo run build`                 | `vx run build --all`                                   |
| `turbo run build --filter=@app/*` | `vx run build --filter "@app/*"`                       |
| `turbo run build --affected`      | `vx run build --affected` (`turbo()` takes `TURBO_SCM_BASE`, or GitHub Actions' base, as Turbo does) |
| `turbo run build --continue`      | `vx run build --continue` (the default is `deps-ok`)   |
| `TURBO_TOKEN` remote cache        | [`turboCache()`](../ci/#remote-cache) reads the same variables |

## Nx

1. Install vx: `npm install -D @vzn/vx` (pnpm: `pnpm add -D -w @vzn/vx`).
2. Run `npx vx init`. Beside `nx.json` it writes this `vx.workspace.ts`
   and nothing else. With `turbo.json` there too, it declares `turbo()`.
   A CI file that sets `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` adds `nxCache()`;
   an Nx Cloud workspace is named instead, since vx cannot share its cache.
3. Run the `next:` line it prints. It installs `@vzn/vx-migrate`, then
   runs what `nx run-many -t build` ran, under vx's cache.
4. `vx-migrate` reads the resolved graph, never `nx.json` alone: an
   exported `.nx/workspace-data/project-graph.json`, else the one your
   installed `nx` exports for it (`nx graph`, as `nx()` runs). Without
   `nx` installed it stops and prints the export command.
5. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them
   with `bunx @vzn/vx-migrate`. With `turbo.json` there too, pass
   `--from nx` (or `--from turbo`).

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
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
| `nx affected -t test`                | `vx run test --affected` (`nx()` takes `NX_BASE` or `defaultBase` as its base) |
| `nx graph`                           | `vx run build --all --graph`                              |
| `nx reset`                           | `vx cache prune`, or remove the cache directory `vx info` names; there is no daemon |
| Nx Cloud cache                       | [`nxCache()`](../ci/#remote-cache) for a self-hosted Nx cache |

Generators, Nx Console and module-boundary rules have no vx equivalent;
keep Nx for those.

## Common problems

- **No workspace root.** vx finds projects through `pnpm-workspace.yaml` or `package.json` `workspaces`. `nx()` adds each Nx project the graph names that no package glob lists (a `project.json` library, the root project).
- **A task always runs.** vx caches only a task with a `cache` block. `vx-migrate` fills it from `turbo.json` or the Nx graph; a Turbo task with `cache: false` has none.
- **An env var is missing in the command.** vx isolates the environment: list it in `exec.env.passThrough` ([Environment variables](../configure/#environment-variables)).
- **`vx run build` ran one package.** Without `--all`, vx runs the package you are in.

Every Turborepo and Nx behaviour, spelled in vx and pinned by a test: the
[parity map](../../parity/).
