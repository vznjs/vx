# @vzn/vx-plugin-examples

One small, runnable plugin per seam. Each file is a complete plugin, and
`tests/examples.test.ts` runs each through vx's `run()` (or the CLI, for
the verb), so an example that stops working turns the gate red. Private:
copy what you need.

| Seam        | File                                   | What it does                                                                       |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `executor`  | [`src/executor.ts`](src/executor.ts)   | runs a task's command in its own process group; stops it on the request's `signal` |
| `cache`     | [`src/cache.ts`](src/cache.ts)         | a directory as the remote store, behind `LayeredCache`                             |
| `telemetry` | [`src/telemetry.ts`](src/telemetry.ts) | appends one JSON line per run to a file                                            |
| `schedule`  | [`src/schedule.ts`](src/schedule.ts)   | named tasks start first                                                            |
| `admit`     | [`src/admit.ts`](src/admit.ts)         | at most one task of a name runs at a time                                          |
| `commands`  | [`src/commands.ts`](src/commands.ts)   | `vx cache-dir` prints the cache directory                                          |
| `project`   | [`src/project.ts`](src/project.ts)     | each `package.json` script becomes a task                                          |
| `graph`     | [`src/graph.ts`](src/graph.ts)         | tasks of a name run one after another across projects                              |
| `key`       | [`src/key.ts`](src/key.ts)             | folds environment variables into every cache key                                   |

Use one in `vx.workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx'
import { envKey } from './plugins/key.ts'

export default defineWorkspace({ plugins: [envKey(['NODE_ENV'])] })
```
