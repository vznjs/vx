---
title: Migrate
description: Run a Turborepo or Nx repo under vx with no file rewritten, then let `bunx @vzn/vx-migrate` write vx.config.ts files when you are ready.
---

Run your Turborepo or Nx repo under vx today, and move its config to
TypeScript at your own pace.

## Turborepo

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add this `vx.workspace.ts`. It is the only new file.
3. Run `vx run build --all`. It runs what `turbo run build` ran, under vx's cache.
4. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`. It never overwrites a file without `--force`.
5. Review each `TODO(vx-migrate)` comment. A package with its own `vx.config.ts` keeps it; `turbo()` fills only the rest.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { turbo } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turbo()] })
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
| `outputLogs`                                                | `"new-only"` is the default; other values are the run's `--output-logs` |
| `extends`                                                   | nothing: a package task merges over the root's, field by field           |
| `$TURBO_ROOT$/file`                                         | `cache.inputs.workspaceFiles` / `outputs.workspaceFiles`                 |
| `globalDependencies` / `globalEnv` / `globalPassThroughEnv` | a generated `vx-preset.ts` you import                                    |

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

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add this `vx.workspace.ts`. It is the only new file.
3. Run `vx run build --all`. It runs what `nx run-many -t build` ran, under vx's cache.
4. Write the resolved graph: `nx graph --file=.nx/workspace-data/project-graph.json`. `vx-migrate` reads it and never guesses from `nx.json`.
5. Preview the configs with `bunx @vzn/vx-migrate --dry`, then write them with `bunx @vzn/vx-migrate`.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
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
| `{ "runtime": "<cmd>" }`             | `cache.inputs.runtime`                                    |
| `outputs`                            | `cache.outputs.files` (or `workspaceFiles` for `dist/<project>`) |
| `nx build app`                       | `vx run app#build`                                        |
| `nx run app:build:production`        | `vx run app#build:production`                             |
| `nx affected -t test`                | `vx run test --affected`                                  |
| `nx graph`                           | `vx run build --graph`                                    |
| `nx reset`                           | nothing: there is no daemon                               |
| Nx Cloud cache                       | [`nxCache()`](../ci/#remote-cache) for a self-hosted Nx cache |

Generators, Nx Console and module-boundary rules have no vx equivalent;
keep Nx for those.

## Common problems

- **A task always runs.** vx caches only a task with a `cache` block. `vx-migrate` fills it from `turbo.json` or the Nx graph.
- **An env var is missing in the command.** vx isolates the environment: list it in `exec.env.passThrough` ([Environment variables](../configure/#environment-variables)).
- **`vx run build` ran one package.** Without `--all`, vx runs the package you are in.

Every Turborepo and Nx behaviour, spelled in vx and pinned by a test: the
[parity map](../../parity/).
