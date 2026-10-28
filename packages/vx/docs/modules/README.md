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

| File                           | Topic                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| [`bin.md`](./bin.md)           | `src/bin.ts` — shebang entry; wires `process.argv` to cli `run`.      |
| [`config.md`](./config.md)     | `src/config.ts` — public schema types + `defineProject` helpers.      |
| [`index.md`](./index.md)       | `src/index.ts` — public package façade (re-exports only).             |
| [`settings.md`](./settings.md) | `src/settings.ts` — every setting once: path, variable, flag, parser. |
| [`version.md`](./version.md)   | `src/version.ts` — the `VERSION` constant (cycle-free leaf).          |

## CLI

| File                                         | Topic                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cli.md`](./cli.md)                         | `src/cli/index.ts` — module contract: the dispatcher, every verb loaded on use.                                                                                                                                                                                                                                                                             |
|                                              | `src/cli/workspace-config.ts` — the workspace as every verb sees it: config stage applied, cache dir, staged projects (see cli.md).                                                                                                                                                                                                                         |
| [`cli-run.md`](./cli-run.md)                 | `src/cli/run.ts` — the `vx run` parser and verb; `src/cli/select.ts` — scope, affected owners, picker; `src/cli/task-verb.ts` — a task typed as a verb, or Nx's `project:target` outside a project, answered with its `vx run`.                                                                                                                             |
| [`cli-watch.md`](./cli-watch.md)             | `src/cli/watch.ts` — `vx watch <task>`: re-run on FS change; `src/cli/watch-fs.ts` — the OS watcher, its poller fallback, the mtime clock. `src/cli/watch-filter.ts` — which events matter; `src/cli/watch-set.ts` — what is watched; `src/cli/watch-judge.ts` — which settled paths are changes; `src/cli/watch-cycle.ts` — one run, stoppable by an edit. |
| [`cli-cache.md`](./cli-cache.md)             | `src/cli/cache.ts` — `vx cache clean`, duration / size parsers.                                                                                                                                                                                                                                                                                             |
|                                              | `src/cli/docs.ts` — `vx docs <query>`: the reference at the version's tag on GitHub, searched (cli.md § `vx docs`).                                                                                                                                                                                                                                         |
| [`cli-help.md`](./cli-help.md)               | `src/cli/help.ts` — static help text; `src/cli/core-alias.ts` — the `@vzn/vx` virtual module bin.ts registers (see `bin.md`); `src/cli/completions.ts` — the `vx completions` script over the verb table and each verb's help cut.                                                                                                                          |
| [`plugin-commands.md`](./plugin-commands.md) | `src/cli/plugin-commands.ts` — plugin-contributed verbs (`VxPlugin.commands`).                                                                                                                                                                                                                                                                              |
| [`cli-format.md`](./cli-format.md)           | `src/cli/format.ts` — `formatBytes` and other shared formatters.                                                                                                                                                                                                                                                                                            |
| [`plan-format.md`](./plan-format.md)         | `src/cli/plan-format.ts` — plan → text / JSON / DOT.                                                                                                                                                                                                                                                                                                        |
| [`handoff.md`](./handoff.md)                 | `src/handoff.ts` — a global vx hands off to the project's own.                                                                                                                                                                                                                                                                                              |
| [`upgrade.md`](./upgrade.md)                 | `src/cli/upgrade.ts` — `vx upgrade`: a verified binary, or its package manager; `src/cli/registry.ts` — the npm registry releases are read from.                                                                                                                                                                                                            |

The remaining subcommand parsers —
`src/cli/{lock,show,info,last,why,init}.ts`
— are user-facing commands documented in [`docs/cli.md`](../cli.md)
rather than as module pages; `src/cli/plugin-templates.ts`
is the generated copy of the example plugins `vx init --plugin` writes.
`tests/doc-references.test.ts` holds this index
to the tree: every `src/**/*.ts` except the `index.ts` files is named
here, itself or in a brace group.

## Orchestrator

| File                                               | Topic                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`orchestrator.md`](./orchestrator.md)             | `src/orchestrator/{index,run}.ts` — module contract + `run()` / `planRun()` entry.                                                                                                                                             |
|                                                    | `src/orchestrator/run-records.ts` — the runs rows, invocation header and telemetry mirror from one pass (see orchestrator.md).                                                                                                 |
|                                                    | `src/orchestrator/run-report.ts` — the report plugin teardowns read; keeps each task's run bytes in a remote as it ends (see plugin.md).                                                                                       |
|                                                    | `src/orchestrator/task-artifacts.ts` — a task's entry by key, saved and restored for an executor that runs it elsewhere (see orchestrator.md).                                                                                 |
|                                                    | `src/orchestrator/persistent.ts` — keep-alive selection and bounded shutdown of persistent children (see orchestrator.md).                                                                                                     |
|                                                    | `src/orchestrator/run-stop.ts` — one stop for the run: `RunOptions.signal` and a process signal abort it; owns the live-child registries (see orchestrator.md).                                                                |
|                                                    | `src/orchestrator/run-lock.ts` — one run at a time per workspace on this machine; runs in one process share it (see orchestrator.md).                                                                                          |
|                                                    | `src/orchestrator/steps.ts` — vx's own steps (`vx:keys`, `<plugin>:setup`) timed for the logger, a passthrough when nothing renders them (see logger.md).                                                                      |
| [`options.md`](./options.md)                       | `src/orchestrator/options.ts` — `RunOptions` / `RunSummary` declarations; `src/orchestrator/run-settings.ts` fills them from the settings.                                                                                     |
| [`execute-task.md`](./execute-task.md)             | `src/orchestrator/execute-task.ts` — per-task: hash → cache lookup → spawn → save.                                                                                                                                             |
|                                                    | `src/orchestrator/execute-args.ts` — a dispatch's `ExecuteArgs`: the run's half (`RunScope`) built once, the task's half per task (see execute-task.md).                                                                       |
|                                                    | `src/orchestrator/{persistent-task,held-servers}.ts` — a persistent task: keyed, spawned, held until `readyWhen` (see execute-task.md § B); a server held until the remote answers its dependants.                             |
|                                                    | `src/orchestrator/task-process.ts` — a task process's env and timeout, shared by both spawning paths (see execute-task.md).                                                                                                    |
| [`sandbox-request.md`](./sandbox-request.md)       | `src/orchestrator/sandbox-request.ts` — arming the runtime for a run; the sandbox half of an ExecuteRequest: grants, binds.                                                                                                    |
| [`keyed-projects.md`](./keyed-projects.md)         | `src/orchestrator/keyed-projects.ts` — the projects a task's key answers for, which bound a cached task's linked-package grant.                                                                                                |
| [`execute-task.md`](./execute-task.md) § Verdict   | `src/orchestrator/shell-verdict.ts` — the frame line for exit 126, 127 and 128 + n: the PATH rule, the file, the signal.                                                                                                       |
| [`miss-save.md`](./miss-save.md)                   | `src/orchestrator/miss-save.ts` — what a miss leaves behind: resolve outputs, save, mark git.                                                                                                                                  |
| [`miss-save.md`](./miss-save.md) § The save lane   | `src/orchestrator/save-lane.ts` — the bounded off-slot save queue `run()` drains before the upload drain.                                                                                                                      |
| [`lockfile-claim.md`](./lockfile-claim.md)         | `src/orchestrator/lockfile-claim.ts` — the claimant's shell a lockfile plugin wraps its parser in, and `reachDigests`.                                                                                                         |
| [`hit-restore.md`](./hit-restore.md)               | `src/orchestrator/{hit-restore,output-log}.ts` — what a hit leaves behind: the two proofs, clean + restore, mark git, replay output; the stored output log.                                                                    |
| [`task-hash.md`](./task-hash.md)                   | `src/orchestrator/task-hash.ts` — cache-key derivation (`computeTaskHash` & co.).                                                                                                                                              |
| [`upstream.md`](./upstream.md)                     | `src/orchestrator/upstream.ts` — which upstream hashes a key folds, by `inputs.tasks` (over `graph/folds.ts`'s `selectFoldedDeps`, one matcher for every path).                                                                |
| [`affected-tasks.md`](./affected-tasks.md)         | `src/orchestrator/{affected-tasks,graph-stage}.ts` — which requested tasks `--affected`'s diff reaches along `dependsOn`; the `graph` stage.                                                                                   |
| [`excluded-keys.md`](./excluded-keys.md)           | `src/orchestrator/excluded-keys.ts` — the key of a dependency `--exclude-dependencies` keeps from running, and the taint it seeds.                                                                                             |
| [`colors.md`](./colors.md)                         | `src/util/{colors,report}.ts` — ANSI gate + truecolor helpers, the brand rule; task output stripped where vx prints plain.                                                                                                     |
| [`ui.md`](./ui.md)                                 | `src/util/ui.ts` — output components (status, notice, fields, report, table) every verb and plugin draws with.                                                                                                                 |
| [`plan.md`](./plan.md)                             | `src/orchestrator/plan.ts` — `--dry` planning (no exec).                                                                                                                                                                       |
| [`placement.md`](./placement.md)                   | `src/orchestrator/placement.ts` — where each task runs: pins, executor order, `'only'`, pools, the `--dry` view.                                                                                                               |
|                                                    | `src/orchestrator/local-floor.ts` — the local executor for a plugin that runs tasks itself, arming the sandbox where no run did (executor.md).                                                                                 |
| [`signals.md`](./signals.md)                       | `src/orchestrator/signals.ts` — SIGINT/SIGTERM/SIGHUP forwarded, as a group signal, to every child, then die of it (128+signo).                                                                                                |
| [`admission.md`](./admission.md)                   | `src/orchestrator/admission.ts` — between scheduler and task: in-flight dedup (an embedder's registry) and continue-taint.                                                                                                     |
| [`run-artifacts.md`](./run-artifacts.md)           | `src/orchestrator/run-artifacts.ts` — `--profile` trace writer.                                                                                                                                                                |
| [`prepare.md`](./prepare.md)                       | `src/orchestrator/prepare.ts` — shared run / planRun setup (workspace, graph, cache).                                                                                                                                          |
| [`projects.md`](./projects.md)                     | `src/orchestrator/projects.ts` — the staged project-config load runs and `vx show` share.                                                                                                                                      |
| [`plugin.md`](./plugin.md)                         | `src/orchestrator/plugin.ts` — `VxPlugin` capabilities + installer.                                                                                                                                                            |
| [`plugin-host.md`](./plugin-host.md)               | `src/orchestrator/{plugin-host,output-host}.ts` — capability consultation + end-of-run teardown/flush; the `output` claim.                                                                                                     |
| [`telemetry.md`](./telemetry.md)                   | `src/orchestrator/telemetry.ts` — versioned telemetry export contract.                                                                                                                                                         |
| [`telemetry-host.md`](./telemetry-host.md)         | `src/orchestrator/telemetry-host.ts` — sink consultation (zero-sink = zero cost).                                                                                                                                              |
| [`run-context.md`](./run-context.md)               | `src/orchestrator/run-context.ts` — git / CI / host capture (≤1 spawn).                                                                                                                                                        |
| [`stable-keys.md`](./stable-keys.md)               | `src/orchestrator/stable-keys.ts` — shared stable-key derivation + stability gate.                                                                                                                                             |
| [`run-keys.md`](./run-keys.md)                     | `src/orchestrator/run-keys.ts` — a warm run's up-front keys, read back whole when nothing they fold moved.                                                                                                                     |
| [`graph-memo.md`](./graph-memo.md)                 | `src/orchestrator/graph-memo.ts` — the task graph, read back whole when the lock and edges did not move.                                                                                                                       |
| [`fingerprint-watch.md`](./fingerprint-watch.md)   | `src/orchestrator/fingerprint-watch.ts` — has a task rewritten the lockfile mid-run? Re-checked only after one that may.                                                                                                       |
| [`task-hash.md`](./task-hash.md)                   | `src/orchestrator/command-windows.ts` — when each command ran and where it may write, for `'mutable'` (described in task-hash.md).                                                                                             |
| [`download-policy.md`](./download-policy.md)       | `src/orchestrator/download-policy.ts` — `--cache-download` modes + the deferral eligibility gate.                                                                                                                              |
| [`deferred-outputs.md`](./deferred-outputs.md)     | `src/orchestrator/deferred-outputs.ts` — deferred-output registry + lazy materialise/converge.                                                                                                                                 |
| [`local-shortcircuit.md`](./local-shortcircuit.md) | `src/orchestrator/local-shortcircuit.ts` — restore-ahead classify (two-tier schedule).                                                                                                                                         |
| [`remote-prefetch.md`](./remote-prefetch.md)       | `src/orchestrator/remote-prefetch.ts` — background remote GETs (LayeredCache only).                                                                                                                                            |
| [`metrics.md`](./metrics.md)                       | `src/orchestrator/{run-failures,run-steps,sandbox-fix}.ts` — a failed run's kept output, the steps a run did not wait on, and the sandbox grants it needed; `src/orchestrator/run-id.ts` — a run id whole or by unique prefix. |
| [`doctor.md`](./doctor.md)                         | `src/orchestrator/doctor.ts` — the workspace doctor's facts behind `vx info`.                                                                                                                                                  |
| [`task-log-buffer.md`](./task-log-buffer.md)       | `src/orchestrator/task-log-buffer.ts` — bounded per-task log capture for telemetry sinks.                                                                                                                                      |

## Report

| File                                     | Topic                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`logger.md`](./logger.md)               | `src/report/{logger,forecast,terminal-signals,path-links}.ts` — default logger (flow-aware policy, frames, replay), live ETA and critical path, tab progress and notification, file links in failed output. |
| [`status-line.md`](./status-line.md)     | `src/report/status-line.ts` — serialized writer + dynamic bottom status line.                                                                                                                               |
| [`framed-output.md`](./framed-output.md) | `src/report/framed-output.ts` — `┌─ task ─┐` border helpers + one-liners.                                                                                                                                   |
| [`colors.md`](./colors.md)               | `src/report/plain-output.ts` — task output stripped of ANSI where no terminal reads it (see colors.md).                                                                                                     |
| [`summary.md`](./summary.md)             | `src/report/summary.ts` — the footer: `projects` / `tasks` / `cache` meters, `info` and `time` rows.                                                                                                        |
| [`tally.md`](./tally.md)                 | `src/report/tally.ts` — outcome tally for the end-of-run footer.                                                                                                                                            |
| [`events.md`](./events.md)               | `src/report/events.ts` — run event bus + serializable `WireEvent` contract.                                                                                                                                 |

## History

| File                                 | Topic                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [`history.md`](./history.md)         | `src/history/history.ts` — per-task duration history behind `--dry` predictions.                           |
|                                      | `src/history/failure-mode.ts` — the flakiness verdict, in one place (see history.md).                      |
| [`metrics.md`](./metrics.md)         | `src/history/metrics.ts` — run-history queries behind `vx last` / `vx why`.                                |
| [`miss-reason.md`](./miss-reason.md) | `src/history/miss-reason.ts` — what a miss's key changed since the last saved entry, for a telemetry sink. |

## Workspace + discovery

| File                                       | Topic                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`workspace.md`](./workspace.md)           | `src/workspace/{workspace,load-reads,repo-id}.ts` — `findWorkspaceRoot`, `findProjectConfigs`, names, cacheDir, store id; root reads once. |
| [`project-loader.md`](./project-loader.md) | `src/workspace/project-loader.ts` — `vx.config.*` / `.vx/workspace.*` evaluation.                                                          |
| [`config-schema.md`](./config-schema.md)   | `src/workspace/config-schema.ts` — what a config may say: the validators, every level.                                                     |
|                                            | `src/workspace/json-data.ts` — a config is JSON data: the one rule the loader and the config worker run (see config-schema.md).            |
| [`package-graph.md`](./package-graph.md)   | `src/workspace/package-graph.ts` — project graph from plugin edges.                                                                        |
|                                            | `src/workspace/dependency-rules.ts` — `run.rules.dependencies` held to the graph's direct deps (see package-graph.md).                     |
| [`filter.md`](./filter.md)                 | `src/workspace/filter.ts` — pnpm-style `--filter` DSL parser + applier.                                                                    |
| [`affected.md`](./affected.md)             | `src/workspace/affected.ts` — git-relative project selection.                                                                              |
| [`config-imports.md`](./config-imports.md) | `src/workspace/config-imports.ts` — the config-import selection channel; the files `vx watch` watches.                                     |
| [`nested-dirs.md`](./nested-dirs.md)       | `src/workspace/nested-dirs.ts` — boundary set (other projects rooted under each).                                                          |
| [`fingerprint.md`](./fingerprint.md)       | `src/workspace/fingerprint.ts` — reads the root files a plugin claims (a lockfile, install settings); folds none.                          |
| [`lockfile.md`](./lockfile.md)             | `src/workspace/lockfile.ts` — `.vx/projects.lock.json` freeze / trust / audit.                                                             |
| [`migration.md`](./migration.md)           | `src/workspace/migration.ts` — the plan → files seam `@vzn/vx-migrate` and any adoption tool write through.                                |
|                                            | `src/workspace/config-eval.ts` — fresh re-evaluation in a Worker (see project-loader.md).                                                  |
|                                            | `src/workspace/config-bytecode.ts` — the workspace config's cached bytecode bundle (see project-loader.md).                                |

## Graph + scheduler

| File                                         | Topic                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`task-graph.md`](./task-graph.md)           | `src/graph/task-graph.ts` — TaskNode DAG builder + cycle detection.                                       |
|                                              | `src/graph/definition.ts` — `taskDefinition(s)`, what history keys a task by (see task-graph.md).         |
|                                              | `src/graph/default-build.ts` — the `build` a project declaring none gets (see task-graph.md).             |
|                                              | `src/graph/critical-path.ts` — `criticalPath`, the order a `schedule` plugin returns (see task-graph.md). |
| [`scheduler.md`](./scheduler.md)             | `src/graph/scheduler.ts` — parallel topological executor.                                                 |
|                                              | `src/graph/priorities.ts` — the ready-queue ranking (see scheduler.md).                                   |
|                                              | `src/graph/task-status.ts` — the status vocabulary (see scheduler.md).                                    |
| [`dependency-spec.md`](./dependency-spec.md) | `src/graph/dependency-spec.ts` — shared Turbo/Nx micro-syntax parser.                                     |
| [`folds.md`](./folds.md)                     | `src/graph/folds.ts` — which dependencies a key folds (`inputs.tasks`).                                   |

## Cache cluster

| File                                     | Topic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cache.md`](./cache.md)                 | `src/cache/cache.ts` — local cache: `bun:sqlite` index + tar.zst artifacts.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                          | `src/cache/{layer,policy,zstd,schema,file-hashes,fold-memo,output-index,run-history,remote-hits,key-fold}.ts` — the slices `Cache` composes (cache.md § Files); `src/cache/fs-clock.ts` — the file system clock lag every racy window adds (cache.md); `src/cache/linked-inputs.ts` — what a symlinked input points to, keyed (cache.md); `src/cache/{archive,tar-stream}.ts` — pack / scan / extract (cache.md, caching.md § Storage layout); `src/cache/umask.ts` — the process umask a restore applies (caching.md § Storage layout). |
| [`layered-cache.md`](./layered-cache.md) | `src/cache/layered-cache.ts` — the local cache with the declared remotes behind it + `RemoteCacheLayer` seam.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`remote-lane.md`](./remote-lane.md)     | `src/cache/remote-lane.ts` — one declared remote: its gate, boundary, upload pool and warnings.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [`inputs.md`](./inputs.md)               | `src/cache/inputs.ts` — glob resolution, boundary enforcement, `cleanOutputs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`git-inputs.md`](./git-inputs.md)       | `src/cache/git-inputs.ts` — the git enumeration (`ls-files`, `status`, `check-attr`) the resolver trusts.                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Exec (process primitives)

| File                                         | Topic                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`runner.md`](./runner.md)                   | `src/exec/runner.ts` — `runCommand`, `runPersistent`, `shellQuote`.                                                   |
| [`kill-tree.md`](./kill-tree.md)             | `src/exec/kill-tree.ts` — `killTree`: a task's process group dies with it (timeout, signal, shutdown).                |
| [`proc-sample.md`](./proc-sample.md)         | `src/exec/proc-sample.ts` — `sampleTrees`: a running task's process tree CPU and memory, for `task.sample`.           |
| [`env.md`](./env.md)                         | `src/exec/env.ts` — child env composition; `src/util/essential-env.ts` — the essential allowlist.                     |
| [`sandbox-runtime.md`](./sandbox-runtime.md) | `src/exec/sandbox-runtime.ts` — `runSandboxed` + violation tracking via `@anthropic-ai/sandbox-runtime`.              |
|                                              | `src/exec/sandbox-violations.ts` — strace pass, seatbelt record description, report filters (see sandbox-runtime.md). |
|                                              | `src/exec/sandbox-binds.ts` — bwrap-honourable write grants, read-grant punching, the SRT custom config.              |
|                                              | `src/exec/sandbox-paths.ts` — `toRealPath`, `absolutize`, `atOrUnder`, `isUnderAny`, `sandboxReads`, `unique`.        |
|                                              | `src/exec/sandbox-deny-scan.ts` — SRT's mandatory write denies, scanned within each task's write grants.              |
| [`executor.md`](./executor.md)               | `src/exec/executor.ts` — `TaskExecutor` contract + `selectExecutor`.                                                  |
|                                              | `src/exec/local-executor.ts` — the floor: run it here (see executor.md, plugins.md).                                  |

## Plugins

| File                                   | Topic                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`plugins.md`](./plugins.md)           | Core ships no plugin: the floor (run here, cache here) and where plugins live (`packages/vx-*`).    |
| [`scoped-cache.md`](./scoped-cache.md) | `src/cache/scoped-cache.ts` — the key a scope stores a plugin entry under.                          |
| [`plugin-cache.md`](./plugin-cache.md) | `src/cache/{plugin-cache,run-store}.ts` — a plugin's own entries (`ctx.cache`); a run's kept bytes. |

## Utilities

| File                                               | Topic                                                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`util-paths.md`](./util-paths.md)                 | `src/util/paths.ts` — POSIX-path normaliser for stable cache keys.                                                                                                                                  |
| [`util-hash.md`](./util-hash.md)                   | `src/util/hash.ts` — xxHash3 helpers shared by every key-derivation site.                                                                                                                           |
| [`util-ulid.md`](./util-ulid.md)                   | `src/util/ulid.ts` — run-id generator (`Bun.randomUUIDv7` wrapper).                                                                                                                                 |
| [`util-errors.md`](./util-errors.md)               | `src/util/errors.ts` — `UserError` class for stack-less error reporting; `src/util/config-frame.ts` — a config refusal at its line; `src/util/refusal-notice.ts` — every refusal drawn as a notice. |
| [`timing.md`](./timing.md)                         | `src/util/timing.ts` — the `VX_DEBUG_TIMING=1` stage table + per-task spans.                                                                                                                        |
| [`util-edit-distance.md`](./util-edit-distance.md) | `src/util/edit-distance.ts` — the one "did you mean" rule.                                                                                                                                          |
| [`util-bun-version.md`](./util-bun-version.md)     | `src/util/bun-version.ts` — the Bun floor, read at run time, and what breaks below it.                                                                                                              |
| [`util-num.md`](./util-num.md)                     | `src/util/num.ts` — `MAX_TIMEOUT_MS`, `clampInt`, `parseDecimalInt`.                                                                                                                                |
| [`util-settle.md`](./util-settle.md)               | `src/util/settle.ts` — the end-of-run settle bound for plugin teardown.                                                                                                                             |
| [`util-tail.md`](./util-tail.md)                   | `src/util/tail.ts` — head-evicting tail for a persistent task's output.                                                                                                                             |
| [`util-secret-mask.md`](./util-secret-mask.md)     | `src/util/secret-mask.ts` — masks secret-named variables' values in what vx shows.                                                                                                                  |
| [`util-hide-env.md`](./util-hide-env.md)           | `src/util/hide-env.ts` — `hideEnvFromTasks`: non-dumpable on Linux, startup values zeroed on macOS, so tasks cannot read vx's env.                                                                  |
| [`util-which.md`](./util-which.md)                 | `src/util/which.ts` — `executablePath`: a tool's absolute path on vx's own PATH, found once.                                                                                                        |
| [`util-procfs.md`](./util-procfs.md)               | `src/util/procfs.ts` — `procfsIsOwn`: is `/proc` this pid namespace's view, asked once.                                                                                                             |
| [`util-secrets.md`](./util-secrets.md)             | `src/util/{secrets,hidden-prompt}.ts` — `ctx.secret`: a plugin's OS keychain entries, asked once on a terminal when missing.                                                                        |
| [`util-hangup.md`](./util-hangup.md)               | `src/util/hangup.ts` — `hangupIgnored`: did vx start with SIGHUP ignored (nohup), asked once.                                                                                                       |
| [`util-git-ignored.md`](./util-git-ignored.md)     | `src/util/git-ignored.ts` — whether git ignores everything an output glob writes, asked of git (`check-ignore`, `ls-files`).                                                                        |
| [`util-real-path.md`](./util-real-path.md)         | `src/util/real-path.ts` — `realPath`: the OS's final path; `realpathOf`: realpath past a backslash.                                                                                                 |
| [`util-cgroup.md`](./util-cgroup.md)               | `src/util/cgroup.ts` — the cores and memory this process may use, as its cgroup bounds them.                                                                                                        |
|                                                    | `src/util/{size,verbs}.ts` — `parseSize`, `parseDuration`, `treeBytes` (cli-cache.md) and the core verb list (cli.md).                                                                              |
|                                                    | `src/util/task-id.ts` — `splitTaskId`, the first-`#` inverse of `taskId` (task-graph.md).                                                                                                           |
|                                                    | `src/util/env-flag.ts` — `envFlagOn`: whether `CI` and the like are on (`0`, `false` and empty are off).                                                                                            |

For the public package surface (what `import('@vzn/vx')` resolves to)
see [`index.md`](./index.md).
