---
title: How vx works
description: A mental model for what happens during vx run — discovery, the task graph, content hashing, the cache lookup, and scheduling.
---

This page builds the mental model. Once you understand the five stages of
a run, the config and the caching behavior stop being surprising. For the
blow-by-blow version, see the [Execution lifecycle](../../execution/)
reference.

## A run in five stages

When you type `vx run build`, vx:

0. **Installs the plugins** your `vx.workspace.ts` declares — including
   the ones that provide the executor and the cache. (`config` hook:
   the workspace config, before it is used.)
1. **Discovers** the workspace and its projects.
2. **Loads** the relevant `vx.config.ts` files. (`project` hook: each
   loaded project's tasks, re-validated afterwards.)
3. **Builds the task graph** from `dependsOn` and your package
   dependencies. (`graph` hook: the edges; then `key`, extra material
   per task.)
4. **Hashes** each task's inputs into a cache key.
5. **Schedules** the graph — for each task, a cache lookup decides
   *restore* vs. *execute*, running as many tasks in parallel as your
   concurrency allows. (`schedule` hook: which ready task first;
   `executor` and `cache` decide where it runs and where its artifact
   lives; `telemetry` receives every record.)

Every parenthesis is a plugin hook, and every one is optional — see
[Writing a vx plugin](/vx/guides/plugins/).

### 0. Plugins

Core applies nothing by default. The thing that *runs* a command and the
thing that *stores* an artifact both arrive as plugins — vx ships its own
as `localExecutorPlugin()` and `localCachePlugin()`, and you declare them
like any third-party one. A workspace that declares neither fails before
the first task with a message naming what to add.

This is why the stages below can talk about "the cache" without saying
which one: a local store, a Bazel CAS, or something you wrote all fill
the same seam.

### 1. Discovery

vx finds the workspace root (a `pnpm-workspace.yaml`, a `workspaces`
field, or a bare `package.json`) and the packages in it. A package
becomes a **project** with runnable tasks only when it has a
`vx.config.ts`. vx loads only the configs in scope for the run plus their
dependency closure — a single-package run doesn't pay to evaluate 1000
configs.

### 2. Loading config

Each `vx.config.ts` is real TypeScript, evaluated by Bun directly (no
build step). This is why imports, presets, and computed values work — and
why vx hashes the **resolved object**, not the file text. A shared preset
that changes invalidates every task that uses it.

### 3. Building the graph

vx turns your tasks into a single directed graph:

- Same-package `dependsOn` edges (`'codegen'`).
- Cross-package edges from `'^build'`, resolved against your
  `package.json` `dependencies` (bridging packages that don't declare the
  task to the nearest one that does).
- Explicit `'pkg#task'` edges.

Cycles are detected here and reported with the offending path.

### 4. Hashing inputs

For each task, vx derives a **content hash** from everything it depends
on: the declared input files (read via git's index), tracked env values,
the resolved command, the project's `package.json`, the workspace
lockfile, forwarded `--` args, and the input keys of upstream tasks —
their inputs, never their outputs, so a change cascades through
`dependsOn` without reading a single produced file. Same inputs → same
key → the work has been done before.

Reading file identity from git's index is what makes hashing nearly free:
on a clean tree, deriving every key costs zero file reads and zero stats —
the blob OIDs are already there.

### 5. Scheduling, cache lookup, execution

The scheduler walks the graph in topological order, running independent
tasks in parallel up to your concurrency. For each task:

- **Cache hit** → restore the stored outputs and replay the logs. (With a
  remote cache plugin configured, vx checks local first, then remote,
  hydrating local on a remote hit. Remote lookups are prefetched in the
  background so latency overlaps execution, and any remote failure — a
  timeout, a 500, a corrupt artifact — degrades to a local miss rather
  than failing the run.)
- **Cache miss** → wipe the declared outputs, run the command, then store
  the new outputs and logs under the key.

A failed task aborts its dependents but lets independent siblings finish.
Persistent tasks (dev servers) are started, gated on readiness, and
`SIGTERM`-ed when the run ends.

## Why the cache is trustworthy

Two design choices make hits safe to trust:

- **Strict output ownership.** Declared outputs are wiped before both
  execution and restore, so your tree ends every run bit-identical to the
  cached snapshot — no stale leftovers.
- **Resolved-config hashing.** The key is derived from the *evaluated*
  config object, so a change to a shared preset or a computed value
  correctly invalidates every task that uses it — something static-JSON
  config can't see.

(vx keys purely on inputs — it does not fold an upstream's *output*
content into downstream keys. An upstream that re-runs re-runs its
dependents, the same model as Turborepo and Nx.)

## Why there's no daemon

Everything above is computed fresh each run from the filesystem and git,
cheaply enough that a background process buying "warm graph state" isn't
worth its cost — the staleness windows, the socket state, the `reset`
ritual. vx is cold-start fast by construction. The mechanics behind that
are in [Why vx is fast](../why-vx-is-fast/).

## Go deeper

- **[Why vx is fast](../why-vx-is-fast/)** — the performance engineering.
- **[Caching deep dive](../../caching/)** — exact key derivation and the
  invalidation table.
- **[Execution lifecycle](../../execution/)** — the detailed walkthrough.
