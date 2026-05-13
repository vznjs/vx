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

## Top-level entry

| File                               | Topic                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| [`bin.md`](./bin.md)               | `src/bin.ts` — shebang entry; wires `process.argv` to `cli.run`.   |
| [`cli.md`](./cli.md)               | `src/cli.ts` — argv → subcommand dispatcher; re-exports for tests. |
| [`cli-run.md`](./cli-run.md)       | `src/cli/run.ts` — the `vx run` parser, scope resolver, picker.    |
| [`cli-cache.md`](./cli-cache.md)   | `src/cli/cache.ts` — `vx cache prune`, duration / size parsers.    |
| [`cli-help.md`](./cli-help.md)     | `src/cli/help.ts` — static help text.                              |
| [`cli-format.md`](./cli-format.md) | `src/cli/format.ts` — `formatBytes` and other shared formatters.   |
| [`config.md`](./config.md)         | `src/config.ts` — public schema types + `defineProject` helpers.   |
| [`index.md`](./index.md)           | `src/index.ts` — public re-exports + `VERSION` constant.           |

## Orchestrator

| File                                               | Topic                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`orchestrator.md`](./orchestrator.md)             | `src/orchestrator.ts` — `run()` / `planRun()` entry; workspace → graph → schedule.     |
| [`execute-task.md`](./execute-task.md)             | `src/orchestrator/execute-task.ts` — per-task: hash → cache lookup → spawn → save.     |
| [`fingerprint.md`](./fingerprint.md)               | `src/orchestrator/fingerprint.ts` — workspace fingerprint (lockfile + workspace yaml). |
| [`nested-dirs.md`](./nested-dirs.md)               | `src/orchestrator/nested-dirs.ts` — boundary set (other projects rooted under each).   |
| [`upstream.md`](./upstream.md)                     | `src/orchestrator/upstream.ts` — filter upstream cache hashes by `cache.inputs.tasks`. |
| [`remote-cache-setup.md`](./remote-cache-setup.md) | `src/orchestrator/remote-cache-setup.ts` — env → `LayeredCache` wrap.                  |
| [`logger.md`](./logger.md)                         | `src/orchestrator/logger.ts` — default logger (framed blocks, status, replay).         |
| [`framed-output.md`](./framed-output.md)           | `src/orchestrator/framed-output.ts` — `┌─ task ─┐` border helpers.                     |
| [`colors.md`](./colors.md)                         | `src/orchestrator/colors.ts` — ANSI gate + truecolor helpers.                          |
| [`summary.md`](./summary.md)                       | `src/orchestrator/summary.ts` — tail `Tasks / Cached / Time` block.                    |
| [`plan.md`](./plan.md)                             | `src/orchestrator/plan.ts` — `--dry` / `--graph` planning (no exec).                   |
| [`plan-format.md`](./plan-format.md)               | `src/orchestrator/plan-format.ts` — plan → text / JSON / DOT.                          |
| [`run-artifacts.md`](./run-artifacts.md)           | `src/orchestrator/run-artifacts.ts` — `--summarize` JSON + `--profile` trace writers.  |

## Workspace + discovery

| File                                       | Topic                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| [`workspace.md`](./workspace.md)           | `src/workspace/workspace.ts` — `findWorkspaceRoot`, `listProjects`, cacheDir.    |
| [`project-loader.md`](./project-loader.md) | `src/workspace/project-loader.ts` — `vx.config.*` / `vx.workspace.*` evaluation. |
| [`package-graph.md`](./package-graph.md)   | `src/workspace/package-graph.ts` — workspace dep graph from package.json.        |
| [`filter.md`](./filter.md)                 | `src/workspace/filter.ts` — pnpm-style `--filter` DSL parser + applier.          |
| [`affected.md`](./affected.md)             | `src/workspace/affected.ts` — git-relative project selection.                    |

## Graph + scheduler

| File                                         | Topic                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`task-graph.md`](./task-graph.md)           | `src/graph/task-graph.ts` — TaskNode DAG builder + cycle detection.   |
| [`scheduler.md`](./scheduler.md)             | `src/graph/scheduler.ts` — parallel topological executor.             |
| [`dependency-spec.md`](./dependency-spec.md) | `src/graph/dependency-spec.ts` — shared Turbo/Nx micro-syntax parser. |

## Cache cluster

| File                                     | Topic                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| [`cache.md`](./cache.md)                 | `src/cache/cache.ts` — local v13 cache: `bun:sqlite` + on-disk entry layout.   |
| [`layered-cache.md`](./layered-cache.md) | `src/cache/layered-cache.ts` — local + remote composition behind `CacheLayer`. |
| [`remote-cache.md`](./remote-cache.md)   | `src/cache/remote-cache.ts` — Turborepo `/v8/artifacts/` HTTP client.          |
| [`cache-archive.md`](./cache-archive.md) | `src/cache/cache-archive.ts` — tar.gz pack/unpack bridge for remote artifacts. |
| [`inputs.md`](./inputs.md)               | `src/cache/inputs.ts` — glob resolution, boundary enforcement, `cleanOutputs`. |

## Exec (process primitives)

| File                       | Topic                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| [`runner.md`](./runner.md) | `src/exec/runner.ts` — `runCommand`, `runPersistent`, `shellQuote`. |
| [`env.md`](./env.md)       | `src/exec/env.ts` — child env composition + essential allowlist.    |

## Utilities

| File                                 | Topic                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| [`util-paths.md`](./util-paths.md)   | `src/util/paths.ts` — POSIX-path normaliser for stable cache keys.       |
| [`util-ulid.md`](./util-ulid.md)     | `src/util/ulid.ts` — ULID generator (run-id stamping; no deps).          |
| [`util-errors.md`](./util-errors.md) | `src/util/errors.ts` — `UserError` class for stack-less error reporting. |

For the public package surface (what `import('@vzn/vx')` resolves to)
see [`index.md`](./index.md).
