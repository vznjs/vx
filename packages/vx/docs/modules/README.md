# Module reference

One markdown per module under `src/`; a slice or helper is documented
with the module that owns it (the cache slices in `cache.md`, the
sandbox helpers in `sandbox-runtime.md`), and the CLI verb parsers in
[`docs/cli.md`](../cli.md). Each documents:

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

| File                                         | Topic                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cli.md`](./cli.md)                         | `src/cli/index.ts` — module contract: dispatcher + re-exports for tests.                                                                                                                                                           |
|                                              | `src/cli/workspace-config.ts` — the workspace as every verb sees it: config stage applied, cache dir, staged projects (see cli.md).                                                                                                |
| [`cli-run.md`](./cli-run.md)                 | `src/cli/run.ts` — the `vx run` parser and verb; `src/cli/select.ts` — scope, affected owners, picker.                                                                                                                             |
| [`cli-watch.md`](./cli-watch.md)             | `src/cli/watch.ts` — `vx watch <task>`: re-run on FS change.                                                                                                                                                                       |
| [`cli-cache.md`](./cli-cache.md)             | `src/cli/cache.ts` — `vx cache prune`, duration / size parsers.                                                                                                                                                                    |
| [`cli-help.md`](./cli-help.md)               | `src/cli/help.ts` — static help text; `src/cli/core-alias.ts` — the `@vzn/vx` virtual module bin.ts registers (see `bin.md`); `src/cli/completions.ts` — the `vx completions` script over the verb table and each verb's help cut. |
| [`plugin-commands.md`](./plugin-commands.md) | `src/cli/plugin-commands.ts` — plugin-contributed verbs (`VxPlugin.commands`).                                                                                                                                                     |
| [`cli-format.md`](./cli-format.md)           | `src/cli/format.ts` — `formatBytes` and other shared formatters.                                                                                                                                                                   |
| [`plan-format.md`](./plan-format.md)         | `src/cli/plan-format.ts` — plan → text / JSON / DOT.                                                                                                                                                                               |
| [`upgrade.md`](./upgrade.md)                 | `src/cli/upgrade.ts` — `vx upgrade` binary self-update.                                                                                                                                                                            |

The remaining subcommand parsers —
`src/cli/{lock,show,info,last,why,init}.ts`
— are user-facing commands documented in [`docs/cli.md`](../cli.md)
rather than as module pages. `tests/doc-references.test.ts` holds this index
to the tree: every `src/**/*.ts` is named here, itself or in a brace
group.

## Orchestrator

| File                                               | Topic                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`orchestrator.md`](./orchestrator.md)             | `src/orchestrator/{index,run}.ts` — module contract + `run()` / `planRun()` entry.                                             |
|                                                    | `src/orchestrator/run-records.ts` — the runs rows, invocation header and telemetry mirror from one pass (see orchestrator.md). |
|                                                    | `src/orchestrator/persistent.ts` — keep-alive selection and bounded shutdown of persistent children (see orchestrator.md).     |
| [`options.md`](./options.md)                       | `src/orchestrator/options.ts` — `RunOptions` / `RunSummary` declarations.                                                      |
| [`execute-task.md`](./execute-task.md)             | `src/orchestrator/execute-task.ts` — per-task: hash → cache lookup → spawn → save.                                             |
| [`sandbox-request.md`](./sandbox-request.md)       | `src/orchestrator/sandbox-request.ts` — arming the runtime for a run; the sandbox half of an ExecuteRequest: grants, binds.    |
| [`miss-save.md`](./miss-save.md)                   | `src/orchestrator/miss-save.ts` — what a miss leaves behind: resolve outputs, save, mark git.                                  |
| [`hit-restore.md`](./hit-restore.md)               | `src/orchestrator/hit-restore.ts` — what a hit leaves behind: the two proofs, clean + restore, mark git, replay stdout.        |
| [`task-hash.md`](./task-hash.md)                   | `src/orchestrator/task-hash.ts` — cache-key derivation (`computeTaskHash` & co.).                                              |
| [`upstream.md`](./upstream.md)                     | `src/orchestrator/upstream.ts` — filter upstream cache hashes by `cache.inputs.tasks`.                                         |
| [`logger.md`](./logger.md)                         | `src/orchestrator/logger.ts` — default logger (flow-aware policy, frames, replay).                                             |
| [`status-line.md`](./status-line.md)               | `src/orchestrator/status-line.ts` — serialized writer + dynamic bottom status line.                                            |
| [`framed-output.md`](./framed-output.md)           | `src/orchestrator/framed-output.ts` — `┌─ task ─┐` border helpers + one-liners.                                                |
| [`colors.md`](./colors.md)                         | `src/orchestrator/colors.ts` — ANSI gate + truecolor helpers.                                                                  |
| [`summary.md`](./summary.md)                       | `src/orchestrator/summary.ts` — tail `Tasks / Cached / Time` block.                                                            |
| [`plan.md`](./plan.md)                             | `src/orchestrator/plan.ts` — `--dry` / `--graph` planning (no exec).                                                           |
| [`placement.md`](./placement.md)                   | `src/orchestrator/placement.ts` — where each task runs: pins, executor order, `'only'`, pools, the `--dry` view.               |
| [`signals.md`](./signals.md)                       | `src/orchestrator/signals.ts` — SIGINT/SIGTERM forwarded to every child, then exit 128+signo.                                  |
| [`admission.md`](./admission.md)                   | `src/orchestrator/admission.ts` — between scheduler and task: in-flight dedup (an embedder's registry) and continue-taint.     |
| [`run-artifacts.md`](./run-artifacts.md)           | `src/orchestrator/run-artifacts.ts` — `--summarize` JSON + `--profile` trace writers.                                          |
| [`prepare.md`](./prepare.md)                       | `src/orchestrator/prepare.ts` — shared run / planRun setup (workspace, graph, cache).                                          |
| [`projects.md`](./projects.md)                     | `src/orchestrator/projects.ts` — the staged project-config load runs and `vx show` share.                                      |
| [`tally.md`](./tally.md)                           | `src/orchestrator/tally.ts` — shared outcome tally for summary + summarize JSON.                                               |
| [`events.md`](./events.md)                         | `src/orchestrator/events.ts` — run event bus + serializable `WireEvent` contract.                                              |
| [`plugin.md`](./plugin.md)                         | `src/orchestrator/plugin.ts` — `VxPlugin` capabilities + installer.                                                            |
| [`plugin-host.md`](./plugin-host.md)               | `src/orchestrator/plugin-host.ts` — capability consultation + end-of-run teardown/flush.                                       |
| [`telemetry.md`](./telemetry.md)                   | `src/orchestrator/telemetry.ts` — versioned telemetry export contract.                                                         |
| [`telemetry-host.md`](./telemetry-host.md)         | `src/orchestrator/telemetry-host.ts` — sink consultation (zero-sink = zero cost).                                              |
| [`run-context.md`](./run-context.md)               | `src/orchestrator/run-context.ts` — git / CI / host capture (≤1 spawn).                                                        |
| [`stable-keys.md`](./stable-keys.md)               | `src/orchestrator/stable-keys.ts` — shared stable-key derivation + stability gate.                                             |
| [`download-policy.md`](./download-policy.md)       | `src/orchestrator/download-policy.ts` — `--download` modes + the deferral eligibility gate.                                    |
| [`deferred-outputs.md`](./deferred-outputs.md)     | `src/orchestrator/deferred-outputs.ts` — deferred-output registry + lazy materialise/converge.                                 |
| [`local-shortcircuit.md`](./local-shortcircuit.md) | `src/orchestrator/local-shortcircuit.ts` — restore-ahead classify (two-tier schedule).                                         |
| [`remote-prefetch.md`](./remote-prefetch.md)       | `src/orchestrator/remote-prefetch.ts` — background remote GETs (LayeredCache only).                                            |
| [`history.md`](./history.md)                       | `src/orchestrator/history.ts` — per-task duration history behind `--dry` predictions.                                          |
|                                                    | `src/orchestrator/failure-mode.ts` — the flakiness verdict, in one place (see history.md).                                     |
| [`metrics.md`](./metrics.md)                       | `src/orchestrator/metrics.ts` — run-history queries behind `vx last` / `vx why` / the MCP.                                     |
| [`resources.md`](./resources.md)                   | `src/orchestrator/resources.ts` — `exec.resources` → the scheduler's per-task costs.                                           |
| [`task-log-buffer.md`](./task-log-buffer.md)       | `src/orchestrator/task-log-buffer.ts` — bounded per-task log capture for telemetry sinks.                                      |
| [`run-report.md`](./run-report.md)                 | `src/orchestrator/run-report.ts` — `--report=markdown` table.                                                                  |

## Workspace + discovery

| File                                       | Topic                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`workspace.md`](./workspace.md)           | `src/workspace/workspace.ts` — `findWorkspaceRoot`, `listProjects`, cacheDir.                                                     |
| [`project-loader.md`](./project-loader.md) | `src/workspace/project-loader.ts` — `vx.config.*` / `vx.workspace.*` evaluation.                                                  |
| [`config-schema.md`](./config-schema.md)   | `src/workspace/config-schema.ts` — what a config may say: the validators, every level.                                            |
| [`package-graph.md`](./package-graph.md)   | `src/workspace/package-graph.ts` — workspace dep graph from package.json.                                                         |
| [`filter.md`](./filter.md)                 | `src/workspace/filter.ts` — pnpm-style `--filter` DSL parser + applier.                                                           |
| [`affected.md`](./affected.md)             | `src/workspace/affected.ts` — git-relative project selection.                                                                     |
| [`config-imports.md`](./config-imports.md) | `src/workspace/config-imports.ts` — the config-import selection channel.                                                          |
| [`config-cache.md`](./config-cache.md)     | `src/workspace/config-cache.ts` — cached evaluations of provably-pure configs.                                                    |
| [`nested-dirs.md`](./nested-dirs.md)       | `src/workspace/nested-dirs.ts` — boundary set (other projects rooted under each).                                                 |
| [`fingerprint.md`](./fingerprint.md)       | `src/workspace/fingerprint.ts` — workspace fingerprint (lockfile + workspace yaml).                                               |
| [`lockfile.md`](./lockfile.md)             | `src/workspace/lockfile.ts` — `vx-lock.json` freeze / trust / audit.                                                              |
| [`migration.md`](./migration.md)           | `src/workspace/{migration,migrate-scripts}.ts` — the plan → files seam `vx init` and `@vzn/vx-migrate` share; the scripts mapper. |
|                                            | `src/workspace/config-eval.ts` — fresh re-evaluation in a Worker (see project-loader.md).                                         |

## Graph + scheduler

| File                                         | Topic                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`task-graph.md`](./task-graph.md)           | `src/graph/task-graph.ts` — TaskNode DAG builder + cycle detection.   |
| [`scheduler.md`](./scheduler.md)             | `src/graph/scheduler.ts` — parallel topological executor.             |
| [`dependency-spec.md`](./dependency-spec.md) | `src/graph/dependency-spec.ts` — shared Turbo/Nx micro-syntax parser. |

## Cache cluster

| File                                     | Topic                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cache.md`](./cache.md)                 | `src/cache/cache.ts` — local cache: `bun:sqlite` index + tar.zst artifacts.                                                                                                                                                                 |
|                                          | `src/cache/{layer,policy,zstd,file-hashes,config-evals,output-index,run-history}.ts` — the slices `Cache` composes (cache.md § Files); `src/cache/{archive,tar-stream}.ts` — pack / scan / extract (cache.md, caching.md § Storage layout). |
| [`layered-cache.md`](./layered-cache.md) | `src/cache/layered-cache.ts` — local + remote composition + `RemoteCacheLayer` seam.                                                                                                                                                        |
| [`inputs.md`](./inputs.md)               | `src/cache/inputs.ts` — glob resolution, boundary enforcement, `cleanOutputs`.                                                                                                                                                              |
| [`git-inputs.md`](./git-inputs.md)       | `src/cache/git-inputs.ts` — the git enumeration (`ls-files`, `status`, `check-attr`) the resolver trusts.                                                                                                                                   |

## Exec (process primitives)

| File                                         | Topic                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`runner.md`](./runner.md)                   | `src/exec/runner.ts` — `runCommand`, `runPersistent`, `shellQuote`.                                                   |
| [`env.md`](./env.md)                         | `src/exec/env.ts` — child env composition + essential allowlist.                                                      |
| [`sandbox-runtime.md`](./sandbox-runtime.md) | `src/exec/sandbox-runtime.ts` — `runSandboxed` + violation tracking via `@anthropic-ai/sandbox-runtime`.              |
|                                              | `src/exec/sandbox-violations.ts` — strace pass, seatbelt record description, report filters (see sandbox-runtime.md). |
|                                              | `src/exec/sandbox-binds.ts` — bwrap-honourable write grants, read-grant punching, the SRT custom config.              |
|                                              | `src/exec/sandbox-paths.ts` — `toRealPath`, `absolutize`, `isUnderAny`, `unique`.                                     |
| [`executor.md`](./executor.md)               | `src/exec/executor.ts` — `TaskExecutor` contract + `selectExecutor`.                                                  |
|                                              | `src/exec/local-executor.ts` — the floor: run it here (see executor.md, plugins.md).                                  |

## Plugins

| File                                     | Topic                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`plugins.md`](./plugins.md)             | Core ships no plugin: the floor (run here, cache here) and where plugins live (`packages/vx-*`). |
| [`chained-cache.md`](./chained-cache.md) | `src/cache/chained-cache.ts` — several declared cache layers, chained in order.                  |

## Utilities

| File                                               | Topic                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`util-paths.md`](./util-paths.md)                 | `src/util/paths.ts` — POSIX-path normaliser for stable cache keys.                       |
| [`util-hash.md`](./util-hash.md)                   | `src/util/hash.ts` — xxHash3 helpers shared by every key-derivation site.                |
| [`util-ulid.md`](./util-ulid.md)                   | `src/util/ulid.ts` — run-id generator (`Bun.randomUUIDv7` wrapper).                      |
| [`util-errors.md`](./util-errors.md)               | `src/util/errors.ts` — `UserError` class for stack-less error reporting.                 |
| [`timing.md`](./timing.md)                         | `src/util/timing.ts` — the `VX_TIMING=1` stage table + per-task spans.                   |
| [`util-edit-distance.md`](./util-edit-distance.md) | `src/util/edit-distance.ts` — the one "did you mean" rule.                               |
| [`util-num.md`](./util-num.md)                     | `src/util/num.ts` — `MAX_TIMEOUT_MS`, `clampInt`, `parseDecimalInt`.                     |
| [`util-settle.md`](./util-settle.md)               | `src/util/settle.ts` — the end-of-run settle bound for plugin teardown.                  |
| [`util-tail.md`](./util-tail.md)                   | `src/util/tail.ts` — head-evicting tail for a persistent task's output.                  |
|                                                    | `src/util/{size,verbs}.ts` — `parseSize` (cli-cache.md) and the core verb list (cli.md). |

For the public package surface (what `import('@vzn/vx')` resolves to)
see [`index.md`](./index.md).
