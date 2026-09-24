---
title: Glossary
description: One tool-neutral definition per term, with the name each tool uses for it.
---

Every task runner solves the same handful of problems, and each one names
them differently. This page defines each idea once, without reference to
any tool, then gives the name vx, Turborepo, Nx and Bazel use for it. Compare
tools by what they do, not by what they call it.

The other tools' names were checked against their own documentation on
2026-09-24, and each is linked. A dash means that tool's documentation has
no term for the idea. It does not mean the tool cannot do the thing some
other way.

## Workspace

**The repository as a unit of work: every project in it, their
relationships, and the settings that apply to all of them.** A workspace
is what a single command operates over.

- vx: the workspace, configured by `vx.workspace.ts` ([workspace config](../guides/configure/#workspace-config))
- Turborepo: the Workspace ([package and task graphs](https://turborepo.com/docs/core-concepts/package-and-task-graph))
- Nx: the workspace ([glossary](https://nx.dev/docs/reference/glossary#workspace))
- Bazel: the workspace, organised into [repositories](https://bazel.build/reference/glossary#repository)

## Project

**One buildable unit inside the workspace**, usually a package with its
own `package.json`. Projects depend on each other the way packages do.

- vx: a project, one `vx.config.ts` per package
- Turborepo: a package ([package graph](https://turborepo.com/docs/core-concepts/package-and-task-graph#package-graph))
- Nx: a project ([glossary](https://nx.dev/docs/reference/glossary#project))
- Bazel: a [package](https://bazel.build/reference/glossary#package), holding [targets](https://bazel.build/reference/glossary#target)

## Task

**One command run for one project**: build `ui`, test `api`. The task is
the unit a runner schedules, caches and reports on.

- vx: a task, id `project#task`, declared under `tasks` ([schema](../schema/#taskconfig))
- Turborepo: a task, declared under `tasks` in `turbo.json` ([configuration](https://turborepo.com/docs/reference/configuration#tasks))
- Nx: a task, an invocation of a [target](https://nx.dev/docs/reference/glossary#target) on a project ([glossary](https://nx.dev/docs/reference/glossary#task))
- Bazel: an [action](https://bazel.build/reference/glossary#action), produced from a target by its rule

## Task dependency

**An edge saying one task must finish before another starts**, because the
second reads what the first produced. The common case is "build my
dependencies first", written as the same task in every project this one
depends on.

- vx: `dependsOn: ['^build']`, where `^` means the dependency projects ([`dependsOn`](../schema/#dependson-optional))
- Turborepo: `dependsOn: ["^build"]` ([configuration](https://turborepo.com/docs/reference/configuration#dependson))
- Nx: `dependsOn`, the [task pipeline](https://nx.dev/docs/reference/glossary#task-pipeline)
- Bazel: a [dependency](https://bazel.build/reference/glossary#dependency) between targets, declared in `BUILD` files

## Task graph

**Every task a command will run, with the dependency edges between
them.** The runner derives it from the project graph and the task
dependencies, then schedules it. It is the thing to read when a run does
something surprising.

- vx: the task graph (`vx run --graph`, `vx run --dry=json`)
- Turborepo: the Task Graph ([package and task graphs](https://turborepo.com/docs/core-concepts/package-and-task-graph#task-graph))
- Nx: the task graph ([glossary](https://nx.dev/docs/reference/glossary#graph))
- Bazel: the [action graph](https://bazel.build/reference/glossary#action-graph)

## Project graph

**The projects and the dependencies between them**, read from the package
manager's manifests. The task graph is built on top of it.

- vx: the package graph
- Turborepo: the Package Graph ([package and task graphs](https://turborepo.com/docs/core-concepts/package-and-task-graph#package-graph))
- Nx: the project graph ([glossary](https://nx.dev/docs/reference/glossary#graph))
- Bazel: the [target graph](https://bazel.build/reference/glossary#target-graph)

## Affected

**The projects a change can reach**: those whose files changed, plus
everything that depends on them. Running only the affected tasks is how
a large repository keeps CI proportional to the change.

- vx: `--affected[=<base>]` ([CLI](../cli/))
- Turborepo: `--affected` ([run reference](https://turborepo.com/docs/reference/run#--affected))
- Nx: affected, `nx affected` ([affected](https://nx.dev/docs/features/ci-features/affected))
- Bazel: —

## Inputs

**Everything that can change a task's result**: its source files, its
configuration, the environment variables it reads, and the results of
the tasks it depends on. A runner can have you declare them, or infer
them, and the choice decides what it can prove.

- vx: `cache.inputs`, declared and required, never inferred ([caching](../caching/))
- Turborepo: `inputs` ([configuration](https://turborepo.com/docs/reference/configuration#inputs))
- Nx: cache inputs ([glossary](https://nx.dev/docs/reference/glossary#cache-inputs))
- Bazel: the declared input [artifacts](https://bazel.build/reference/glossary#artifact) of an action

## Outputs

**The files a task produces**, which a cache stores and restores. Terminal
output is usually stored too, so a replayed task prints what it printed.

- vx: `cache.outputs` ([caching](../caching/))
- Turborepo: `outputs` ([configuration](https://turborepo.com/docs/reference/configuration#outputs))
- Nx: cache outputs ([glossary](https://nx.dev/docs/reference/glossary#cache-outputs))
- Bazel: the declared output [artifacts](https://bazel.build/reference/glossary#artifact) of an action

## Cache key

**A digest of a task's inputs.** Two runs with the same key are expected to
produce the same outputs, so the second can replay the first. Everything
that decides the key decides what the cache can be trusted with.

- vx: the cache key, a 16-hex xxHash3 digest ([caching](../caching/))
- Turborepo: the hash, or "fingerprint" ([caching](https://turborepo.com/docs/crafting-your-repository/caching#task-inputs))
- Nx: the hash of the cache inputs ([glossary](https://nx.dev/docs/reference/glossary#cache-inputs))
- Bazel: the [action key](https://bazel.build/reference/glossary#action-key)

## Cache hit, miss and stale hit

**A hit** finds the key in the cache and replays the stored outputs
instead of running the task. **A miss** runs it. **A stale hit** is a hit
whose stored outputs are wrong for today's inputs, because something the
task read was never part of the key. It reports success and serves
yesterday's result, which makes it the worst failure a cache can have.

- vx: hit, miss and stale hit ([caching](../guides/configure/#caching))
- Turborepo: cache hit and cache miss ([caching](https://turborepo.com/docs/crafting-your-repository/caching))
- Nx: cache hit and cache miss ([glossary](https://nx.dev/docs/reference/glossary#cache-hit)); a stale result is called a "false cache hit" in its [sandboxing](https://nx.dev/docs/features/ci-features/sandboxing) docs
- Bazel: served from the [action cache](https://bazel.build/reference/glossary#action-cache); a wrong one breaks [correctness](https://bazel.build/reference/glossary#correctness)

## Remote cache

**A cache shared between machines**, so CI and every developer reuse each
other's results. It makes the cost of a stale hit shared too.

- vx: a remote `CacheLayer` from a plugin, such as `@vzn/vx-reapi` or `turboCache()` ([remote caching](../guides/ci/#remote-cache))
- Turborepo: Remote Caching ([remote caching](https://turborepo.com/docs/core-concepts/remote-caching))
- Nx: remote cache ([glossary](https://nx.dev/docs/reference/glossary#remote-cache)), offered as Nx Replay
- Bazel: remote caching, with a local [disk cache](https://bazel.build/reference/glossary#disk-cache)

## Hermeticity and sandboxing

**A task is hermetic when it reads only its declared inputs and writes
only its declared outputs.** A sandbox enforces that by running the task
where undeclared files cannot be reached, and reporting what it tried.
A sandbox is how a runner proves the key is complete, rather than
trusting it.

- vx: `exec.sandbox`, run locally on Linux and macOS ([sandboxing](../guides/sandboxing/))
- Turborepo: —
- Nx: task sandboxing, an Nx Cloud add-on run on a dedicated compute cluster ([task sandboxing](https://nx.dev/docs/features/ci-features/sandboxing))
- Bazel: [hermeticity](https://bazel.build/reference/glossary#hermeticity), enforced by [sandboxing](https://bazel.build/reference/glossary#sandboxing)

## Remote execution

**Running a task on another machine** and bringing its outputs back, so a
laptop can use a build farm. It needs every input declared, because the
other machine sees nothing else.

- vx: `exec.remote`, through the `@vzn/vx-reapi` plugin ([remote execution](../guides/ci/#remote-execution))
- Turborepo: —
- Nx: distributed task execution, which spreads tasks across CI agents ([glossary](https://nx.dev/docs/reference/glossary#distributed-task-execution))
- Bazel: remote execution, whose protocol (REAPI) the vx plugin speaks

## Persistent task

**A task that does not exit**, such as a dev server or a watcher. A runner
cannot wait for it to finish before starting what depends on it, and it
must never be cached.

- vx: `exec.persistent`, ready when its output matches `readyWhen` ([dev tasks](../guides/configure/#dev-tasks))
- Turborepo: `persistent: true` ([configuration](https://turborepo.com/docs/reference/configuration#persistent))
- Nx: a continuous task, `continuous: true`
- Bazel: —

## Critical path

**The longest chain of dependent work in the task graph.** No amount of
parallelism finishes a run faster than its critical path. A scheduler
that starts the tasks on it first finishes sooner on the same machine.

- vx: with no plugin the scheduler orders ready tasks by how many tasks wait on each; `@vzn/vx-schedule-history` orders them by remaining critical path, learned from past runs ([Concurrency](../guide/concurrency/))
- Turborepo: —
- Nx: the critical path, named where its CI guide says what a cache cannot fix ([CI caching](https://nx.dev/docs/kb/ci-caching))
- Bazel: the critical path, which every build reports and the profiler draws ([JSON trace profile](https://bazel.build/advanced/performance/json-trace-profile))

## Seam and plugin

**A seam is a point in the pipeline where outside code decides.** Examples
are where a task runs, where artifacts live, who observes the run, and how
the graph is shaped. A plugin fills one or more seams. The width of the
seams decides what can be built on a tool without forking it.

- vx: plugin stages from `config` to `telemetry` ([plugins](../guides/plugins/))
- Turborepo: —
- Nx: a [plugin](https://nx.dev/docs/reference/glossary#plugin), which can infer tasks and supply [executors](https://nx.dev/docs/reference/glossary#executor)
- Bazel: [rules](https://bazel.build/reference/glossary#rule) written in [Starlark](https://bazel.build/reference/glossary#starlark)
