# Module reference

One markdown per source module under `src/`. Each documents:

- **Purpose** — what the module exists to do.
- **Public surface** — exported types + functions consumed by other
  modules. The seam for forks / replacements.
- **Algorithm / construction rules** — how it works at a high level.
- **What it does NOT do** — explicit non-features (helps prevent
  scope creep on future PRs).
- **Tests** — where coverage lives.
- **Replacing this module** — what to swap to extend or fork.

Internal helpers are not part of the contract; they can change.

For the high-level data flow, read
[`../architecture.md`](../architecture.md) first.

## Root files

| File                         | Topic                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| [`bin.md`](./bin.md)         | `src/bin.ts` — shebang entry; wires `process.argv` to cli `run`. |
| [`config.md`](./config.md)   | `src/config.ts` — public schema types + `defineProject` helpers. |
| [`index.md`](./index.md)     | `src/index.ts` — public package façade (re-exports only).        |
| [`version.md`](./version.md) | `src/version.ts` — the `VERSION` constant (cycle-free leaf).     |

## CLI

| File                                 | Topic                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [`cli.md`](./cli.md)                 | `src/cli/index.ts` — module contract: dispatcher + re-exports for tests. |
| [`cli-run.md`](./cli-run.md)         | `src/cli/run.ts` — the `vx run` parser, scope resolver, picker.          |
| [`cli-watch.md`](./cli-watch.md)     | `src/cli/watch.ts` — `vx watch <task>`: re-run on FS change.             |
| [`cli-cache.md`](./cli-cache.md)     | `src/cli/cache.ts` — `vx cache prune`, duration / size parsers.          |
| [`cli-help.md`](./cli-help.md)       | `src/cli/help.ts` — static help text.                                    |
| [`cli-format.md`](./cli-format.md)   | `src/cli/format.ts` — `formatBytes` and other shared formatters.         |
| [`plan-format.md`](./plan-format.md) | `src/cli/plan-format.ts` — plan → text / JSON / DOT.                     |

## Orchestrator

| File                                               | Topic                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`orchestrator.md`](./orchestrator.md)             | `src/orchestrator/{index,run}.ts` — module contract + `run()` / `planRun()` entry.     |
| [`options.md`](./options.md)                       | `src/orchestrator/options.ts` — `RunOptions` / `RunSummary` declarations.              |
| [`execute-task.md`](./execute-task.md)             | `src/orchestrator/execute-task.ts` — per-task: hash → cache lookup → spawn → save.     |
| [`task-hash.md`](./task-hash.md)                   | `src/orchestrator/task-hash.ts` — cache-key derivation (`computeTaskHash` & co.).      |
| [`upstream.md`](./upstream.md)                     | `src/orchestrator/upstream.ts` — filter upstream cache hashes by `cache.inputs.tasks`. |
| [`remote-cache-setup.md`](./remote-cache-setup.md) | `src/orchestrator/remote-cache-setup.ts` — env → `LayeredCache` wrap.                  |
| [`logger.md`](./logger.md)                         | `src/orchestrator/logger.ts` — default logger (flow-aware policy, frames, replay).     |
| [`status-line.md`](./status-line.md)               | `src/orchestrator/status-line.ts` — serialized writer + dynamic bottom status line.    |
| [`framed-output.md`](./framed-output.md)           | `src/orchestrator/framed-output.ts` — `┌─ task ─┐` border helpers + one-liners.        |
| [`colors.md`](./colors.md)                         | `src/orchestrator/colors.ts` — ANSI gate + truecolor helpers.                          |
| [`summary.md`](./summary.md)                       | `src/orchestrator/summary.ts` — tail `Tasks / Cached / Time` block.                    |
| [`plan.md`](./plan.md)                             | `src/orchestrator/plan.ts` — `--dry` / `--graph` planning (no exec).                   |
| [`run-artifacts.md`](./run-artifacts.md)           | `src/orchestrator/run-artifacts.ts` — `--summarize` JSON + `--profile` trace writers.  |
| [`prepare.md`](./prepare.md)                       | `src/orchestrator/prepare.ts` — shared run / planRun setup (workspace, graph, cache).  |
| [`tally.md`](./tally.md)                           | `src/orchestrator/tally.ts` — shared outcome tally for summary + summarize JSON.       |

## Workspace + discovery

| File                                       | Topic                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`workspace.md`](./workspace.md)           | `src/workspace/workspace.ts` — `findWorkspaceRoot`, `listProjects`, cacheDir.       |
| [`project-loader.md`](./project-loader.md) | `src/workspace/project-loader.ts` — `vx.config.*` / `vx.workspace.*` evaluation.    |
| [`package-graph.md`](./package-graph.md)   | `src/workspace/package-graph.ts` — workspace dep graph from package.json.           |
| [`filter.md`](./filter.md)                 | `src/workspace/filter.ts` — pnpm-style `--filter` DSL parser + applier.             |
| [`affected.md`](./affected.md)             | `src/workspace/affected.ts` — git-relative project selection.                       |
| [`nested-dirs.md`](./nested-dirs.md)       | `src/workspace/nested-dirs.ts` — boundary set (other projects rooted under each).   |
| [`fingerprint.md`](./fingerprint.md)       | `src/workspace/fingerprint.ts` — workspace fingerprint (lockfile + workspace yaml). |

## Graph + scheduler

| File                                         | Topic                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`task-graph.md`](./task-graph.md)           | `src/graph/task-graph.ts` — TaskNode DAG builder + cycle detection.   |
| [`scheduler.md`](./scheduler.md)             | `src/graph/scheduler.ts` — parallel topological executor.             |
| [`dependency-spec.md`](./dependency-spec.md) | `src/graph/dependency-spec.ts` — shared Turbo/Nx micro-syntax parser. |

## Cache cluster

| File                                     | Topic                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| [`cache.md`](./cache.md)                 | `src/cache/cache.ts` — local cache: `bun:sqlite` index + tar.zst artifacts.    |
| [`layered-cache.md`](./layered-cache.md) | `src/cache/layered-cache.ts` — local + remote composition behind `CacheLayer`. |
| [`remote-cache.md`](./remote-cache.md)   | `src/cache/remote-cache.ts` — Turborepo `/v8/artifacts/` HTTP client.          |
| [`inputs.md`](./inputs.md)               | `src/cache/inputs.ts` — glob resolution, boundary enforcement, `cleanOutputs`. |

## Exec (process primitives)

| File                                         | Topic                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`runner.md`](./runner.md)                   | `src/exec/runner.ts` — `runCommand`, `runPersistent`, `shellQuote`.                                      |
| [`env.md`](./env.md)                         | `src/exec/env.ts` — child env composition + essential allowlist.                                         |
| [`sandbox-runtime.md`](./sandbox-runtime.md) | `src/exec/sandbox-runtime.ts` — `runSandboxed` + violation tracking via `@anthropic-ai/sandbox-runtime`. |

## Utilities

| File                                 | Topic                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------- |
| [`util-paths.md`](./util-paths.md)   | `src/util/paths.ts` — POSIX-path normaliser for stable cache keys.        |
| [`util-hash.md`](./util-hash.md)     | `src/util/hash.ts` — xxHash3 helpers shared by every key-derivation site. |
| [`util-ulid.md`](./util-ulid.md)     | `src/util/ulid.ts` — run-id generator (`Bun.randomUUIDv7` wrapper).       |
| [`util-errors.md`](./util-errors.md) | `src/util/errors.ts` — `UserError` class for stack-less error reporting.  |

For the public package surface (what `import('@vzn/vx')` resolves to)
see [`index.md`](./index.md).
