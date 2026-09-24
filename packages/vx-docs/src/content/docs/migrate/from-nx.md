---
title: Migrate from Nx
description: Run an Nx repo under vx unchanged with `nx()`, then let `bunx @vzn/vx-migrate` write vx.config.ts files from Nx's resolved project graph.
---

Run your Nx repo under vx today, executors included. Replace executors
with plain commands at your own pace.

## Steps

1. Install: `bun add -d @vzn/vx @vzn/vx-migrate`.
2. Add the `vx.workspace.ts` below. It is the only new file.
3. Run `vx run build --all`. It runs what `nx run-many -t build` ran, under vx's cache.
4. Write the resolved graph: `nx graph --file=.nx/workspace-data/project-graph.json`.
5. Preview the configs: `bunx @vzn/vx-migrate --dry`. Then write them: `bunx @vzn/vx-migrate`.
6. Replace each `nx-exec` line with the command the executor wraps, when you want to drop Nx.

## Config

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

## What maps to what

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
| Nx Cloud cache                       | [`nxCache()`](../../guides/remote-caching/#a-hosted-cache-in-three-commands) for a self-hosted Nx cache |

## Common problems

- **`vx-migrate` asks for the graph.** It reads the resolved graph, never guesses from `nx.json`: run step 4 first.
- **A config still runs `nx-exec`.** Keep `nx` and `@vzn/vx-migrate` installed until the last such line is gone.
- **You use generators, Nx Console or module-boundary rules.** vx has none of them; keep Nx for those.

Every Nx behaviour, spelled in vx and pinned by a test: the [parity map](../../parity/).
