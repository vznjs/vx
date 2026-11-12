# @vzn/vx-plugin-examples

One small, runnable plugin for each of nine seams (`config`, `discover`,
`fingerprint`, `measures`, `output`, `setup` and `teardown` have none), each beside its own test:
`plugins/<seam>.ts` and `plugins/<seam>.test.ts`, which drives the plugin
through vx's `run()`. The gate runs every test, so an example that stops
working turns it red. `vx init --plugin <seam>` writes the same two files
into your workspace. The
[plugins guide](../vx-docs/src/content/docs/docs/writing-plugins.mdx#workspace-and-projects)
shows `config`, `discover` and `fingerprint`.

| Seam        | File                                           | What it does                                                                       |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `executor`  | [`plugins/executor.ts`](plugins/executor.ts)   | runs a task's command in its own process group; stops it on the request's `signal` |
| `cache`     | [`plugins/cache.ts`](plugins/cache.ts)         | a directory (from the workspace root) as the remote store, under the local cache   |
| `telemetry` | [`plugins/telemetry.ts`](plugins/telemetry.ts) | appends one JSON line per run to a file (from the workspace root)                  |
| `schedule`  | [`plugins/schedule.ts`](plugins/schedule.ts)   | named tasks start first                                                            |
| `admit`     | [`plugins/admit.ts`](plugins/admit.ts)         | at most one task of a name runs at a time                                          |
| `commands`  | [`plugins/commands.ts`](plugins/commands.ts)   | `vx cache-dir` prints the cache directory                                          |
| `project`   | [`plugins/project.ts`](plugins/project.ts)     | each `package.json` script a task can be named after becomes one                   |
| `graph`     | [`plugins/graph.ts`](plugins/graph.ts)         | tasks of a name run one after another across projects                              |
| `key`       | [`plugins/key.ts`](plugins/key.ts)             | folds environment variables into every cache key                                   |

Lockfile support is not JS-only: [`fingerprint/uv.ts`](fingerprint/uv.ts)
claims Python's `uv.lock` through core's `lockfileClaim`, so each member
keys on its own dependency closure. It lives outside `plugins/`, so
`vx init --plugin` does not offer it.

A migrator is not a seam: it reads another tool's files and hands core's
migration seam (`applyMigration`) a plan, which core renders, guards,
writes and reports. [`migrators/makefile.ts`](migrators/makefile.ts)
turns each project's Makefile targets into tasks, beside its test.

Use one in `.vx/workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { envKey } from '../plugins/key.ts'

export default defineWorkspace({ plugins: [envKey(['NODE_ENV'])] })
```

## Distributed task execution

[`distribute/`](distribute/distribute.ts) spreads one run over worker
processes using only `@vzn/vx`. The executor declares `capabilities`
and fills the `distribution` hooks. Each worker runs its tasks through
`workerRuntime()`, as the local floor would. `@vzn/vx-dte` is the full
one: workers on other machines, files through the cache.
