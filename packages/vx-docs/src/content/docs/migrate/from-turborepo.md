---
title: Migrate from Turborepo
description: Run a Turborepo repo under vx with no file rewritten, then let `bunx @vzn/vx-migrate` write vx.config.ts files from turbo.json.
---

Run your Turborepo repo under vx today. Move its config to TypeScript
when you are ready.

## Steps

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add the `vx.workspace.ts` below. It is the only new file.
3. Run `vx run build --all`. It runs what `turbo run build` ran, under vx's cache.
4. Preview the configs: `bunx @vzn/vx-migrate --dry`.
5. Write them: `bunx @vzn/vx-migrate`. It never overwrites a file without `--force`.
6. Review each `TODO(vx-migrate)` comment. A package with its own `vx.config.ts` keeps it; `turbo()` fills only the rest.

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { turbo } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turbo()] })
```

## What maps to what

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
| `TURBO_TOKEN` remote cache        | [`turboCache()`](../../guides/remote-caching/#a-hosted-cache-in-three-commands) reads the same variables |

## Common problems

- **A task always runs.** vx caches only a task with a `cache` block that names its inputs and outputs. `vx-migrate` fills them from `turbo.json`.
- **An env var is missing in the command.** vx isolates the environment: list it in `exec.env.passThrough`. [Environment variables](../../guides/environment-variables/)
- **`vx run build` ran one package.** Without `--all`, vx runs the package you are in.

Every Turborepo behaviour, spelled in vx and pinned by a test: the [parity map](../../parity/).
