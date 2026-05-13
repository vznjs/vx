# Module reference

One markdown per module under `src/`. Each documents:

- **Purpose** — what the module exists to do
- **Public surface** — types and functions consumed by other modules
- **Construction rules** / **algorithm** — how it works at a high level
- **What it does NOT do** — explicit non-features
- **Tests** — where coverage lives
- **Replacing this module** — extension contract for forks / future work

## Modules

| File                                       | Topic                                    |
| ------------------------------------------ | ---------------------------------------- |
| [`config.md`](./config.md)                 | The public schema (`vx.config.ts` types) |
| [`workspace.md`](./workspace.md)           | pnpm workspace discovery                 |
| [`project-loader.md`](./project-loader.md) | `vx.config.*` evaluation                 |
| [`package-graph.md`](./package-graph.md)   | Workspace dependency graph               |
| [`task-graph.md`](./task-graph.md)         | Task DAG + cycle detection               |
| [`inputs.md`](./inputs.md)                 | Input file + env resolution              |
| [`env.md`](./env.md)                       | Child-process env composition            |
| [`cache.md`](./cache.md)                   | Content-addressed cache + key derivation |
| [`runner.md`](./runner.md)                 | `child_process.spawn` wrapper            |
| [`scheduler.md`](./scheduler.md)           | Parallel topo executor                   |
| [`remote-cache.md`](./remote-cache.md)     | Turbo `/v8/artifacts` HTTP client        |
| [`cache-archive.md`](./cache-archive.md)   | tar.gz pack/unpack for remote artifacts  |
| [`layered-cache.md`](./layered-cache.md)   | Local + remote cache composition         |
| [`orchestrator.md`](./orchestrator.md)     | End-to-end glue                          |
| [`filter.md`](./filter.md)                 | pnpm-style filter DSL (`--filter`)       |
| [`cli.md`](./cli.md)                       | Argv parser + dispatcher                 |

For a higher-level view see [`../architecture.md`](../architecture.md).
