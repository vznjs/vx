---
title: 'A pipeline with seams'
date: 2026-09-10
authors:
  - vzn
tags:
  - design
  - plugins
excerpt: 'vx is built like Vite: a core pipeline with a named hook at every stage, and plugins that fill exactly the stage they need. A remote cache is one hook. A lockfile parser is one hook. Zero-migration Turbo support is one hook.'
---

The word "plugin" usually means one of two things. Either a plugin is a
whole subsystem with its own configuration language (Nx executors), or
it is a callback bolted to one event the tool happened to expose. vx
uses the word the way Vite does: the core is a pipeline, every stage
has a named hook, and a plugin is an object that implements the hooks
it needs.

## The stages

```
config → project → graph → key → fingerprint → schedule
        → executor / cache → telemetry / setup → commands
```

| Stage         | What a plugin can do there                                                                 |
| ------------- | ------------------------------------------------------------------------------------------ |
| `config`      | See and adjust the workspace config before anything uses it.                               |
| `project`     | Add, remove or edit one loaded project's tasks.                                            |
| `graph`       | Add edges, mark tasks requested, attach resources to the whole task graph.                 |
| `key`         | Contribute extra cache-key material per task.                                              |
| `fingerprint` | Claim a lockfile out of the workspace fingerprint and key it per project.                  |
| `schedule`    | Return a priority per ready task.                                                          |
| `executor`    | Decide where one task's command runs.                                                      |
| `cache`       | Provide a layer where artifacts live.                                                      |
| `telemetry`   | Receive immutable run records. Cannot change behaviour, by construction.                   |
| `commands`    | Add a CLI verb. Core's verbs match first; nothing can shadow `vx run`.                     |
| `setup`       | Validate once before any capability is used; `teardown` flushes at the end.                |

A plugin is `definePlugin(import.meta, hooks)`. Its name is its package
name, read from `import.meta`, never a field you set. Declaration order
in `vx.workspace.ts` is the order everywhere: executors are consulted in
order, cache layers are chained in order, telemetry sinks receive in
order.

## What fits in one hook

The proof that the seams are the right width is what has been built on
them without a special case in core:

- **`@vzn/vx-turbo`** fills the `project` stage from a `turbo.json` and
  each package's scripts. A Turborepo workspace runs under vx with a
  two-line workspace file and no config rewritten.
- **`@vzn/vx-lockfile`** uses `fingerprint` to claim `pnpm-lock.yaml`
  (or `bun.lock`, `package-lock.json`, `yarn.lock`) and key each task on
  its own project's dependency closure. `--affected` follows the same
  claim.
- **`@vzn/vx-schedule-history`** fills `schedule` with the critical path
  learned from run history.
- **`@vzn/vx-reapi`** provides both `executor` and `cache` against any
  Bazel Remote Execution API server: remote cache and remote execution
  from one plugin.
- **`@vzn/vx-turbo-cache`** and **`@vzn/vx-nx-cache`** are `cache`
  layers speaking Turbo's `/v8/artifacts` and Nx's `/v1/cache` wire
  formats, so an existing self-hosted cache server keeps working.
- **`@vzn/vx-otel`** and **`@vzn/vx-github`** are `telemetry` sinks: an
  OTLP exporter with no OpenTelemetry SDK dependency, and a GitHub
  Actions job summary plus a check run on the built commit.
- **`@vzn/vx-mcp`** and **`@vzn/vx-prune`** are `commands`: a Model
  Context Protocol server for coding agents, and a workspace subset for
  Docker builds.

Every one of these lives in its own package and imports core only
through `@vzn/vx`'s public façade. A test pins the façade so it cannot
widen by accident.

## The rule that keeps the seams honest

**Seam over special case.** When core grows a branch for one consumer,
the seam is too narrow, and the fix is to widen the seam, not to keep
the branch. Twice in this repository's history a capability shipped
inside core and was moved out once the hook it needed existed: `vx
prune` became `@vzn/vx-prune` on the `commands` seam, and the
run-history scheduler became `@vzn/vx-schedule-history` on `schedule`.
Core got smaller both times.

The second rule is the one that keeps the floor under your feet: core
applies **no** plugin by default and names none. A capability a plugin
must supply, a remote, a wire format, is declared in `vx.workspace.ts`
or it does not exist. The one thing that is implicit is the
[local floor](../the-local-floor/): running here and caching here.

Writing one is a short guide: [Writing a vx plugin](../../guides/plugins/).
