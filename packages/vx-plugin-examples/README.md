# @vzn/vx-plugin-examples

One small, runnable plugin for each of nine seams (`config`, `discover`,
`fingerprint`, `setup` and `teardown` have none), each beside its own test:
`plugins/<seam>.ts` and `plugins/<seam>.test.ts`, which drives the plugin
through vx's `run()`. The gate runs every test, so an example that stops
working turns it red. `vx init --plugin <seam>` writes the same two files
into your workspace. The
[plugins guide](../vx-docs/src/content/docs/guides/plugins.md#workspace-and-projects)
shows `config`, `discover` and `fingerprint`.

| Seam        | File                                           | What it does                                                                       |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `executor`  | [`plugins/executor.ts`](plugins/executor.ts)   | runs a task's command in its own process group; stops it on the request's `signal` |
| `cache`     | [`plugins/cache.ts`](plugins/cache.ts)         | a directory as the remote store, behind `LayeredCache`                             |
| `telemetry` | [`plugins/telemetry.ts`](plugins/telemetry.ts) | appends one JSON line per run to a file                                            |
| `schedule`  | [`plugins/schedule.ts`](plugins/schedule.ts)   | named tasks start first                                                            |
| `admit`     | [`plugins/admit.ts`](plugins/admit.ts)         | at most one task of a name runs at a time                                          |
| `commands`  | [`plugins/commands.ts`](plugins/commands.ts)   | `vx cache-dir` prints the cache directory                                          |
| `project`   | [`plugins/project.ts`](plugins/project.ts)     | each `package.json` script becomes a task                                          |
| `graph`     | [`plugins/graph.ts`](plugins/graph.ts)         | tasks of a name run one after another across projects                              |
| `key`       | [`plugins/key.ts`](plugins/key.ts)             | folds environment variables into every cache key                                   |

Use one in `vx.workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { envKey } from './plugins/key.ts'

export default defineWorkspace({ plugins: [envKey(['NODE_ENV'])] })
```
