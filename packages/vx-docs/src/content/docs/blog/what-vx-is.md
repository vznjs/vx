---
title: 'What vx is, and what it refuses to be'
date: 2026-09-10T23:59:00Z
authors:
  - vzn
tags:
  - announcement
  - design
excerpt: 'vx is a task runner and a content-addressed cache for JavaScript monorepos, and nothing else. This post is the shape of the thing: the five stages, the seams, and the list of features that will never be inside.'
---

Every monorepo tool eventually describes itself with a paragraph of
nouns: caching, task graph, remote execution, affected detection,
generators, a dashboard, a cloud. vx's description is one sentence.

**vx runs and caches a task graph, correctly, and stops there.**

That sentence is a design, not a slogan, and this post walks through
what it commits us to.

## The pipeline

A run is a pipeline with five stages, and each one has a documented
seam a plugin can fill:

1. **Discover** the projects in the workspace (the package manager's
   workspace globs, one `package.json` each).
2. **Evaluate** each `vx.config.ts`. Configs are TypeScript programs,
   not JSON; the pipeline sees the object they evaluate to.
3. **Build** one task graph across the whole workspace from `dependsOn`
   and the package dependency graph.
4. **Derive** a content-addressed key per task from its declared inputs,
   its resolved config, and the keys of everything upstream.
5. **Schedule** the graph: look each key up, restore hits, execute
   misses with bounded parallelism, save results.

In plugin terms the stages are named `config` → `project` → `graph` →
`key` → `fingerprint` → `schedule`, followed by the two behaviour
capabilities `executor` (where a command runs) and `cache` (where
artifacts live), the observe-only `telemetry` capability, and
`commands` (CLI verbs). Core applies **no** plugin by default and names
none. A workspace with no `vx.workspace.ts` still runs and caches,
because the local executor and the local cache are the floor under
every list, not plugins you have to remember to add.

## What a task is

A task is one shell command with declared inputs and outputs:

```ts
build: {
  exec: { command: 'tsc -b' },
  cache: {
    inputs: { files: ['src/**', 'tsconfig.json'] },
    outputs: { files: ['dist/**'] },
  },
}
```

Three rules hold across the whole tool:

- **Caching is opt-in.** No `cache` block, no cache. When there is one,
  both `inputs` and `outputs` are required. vx never infers what a task
  reads.
- **One command per task.** A plugin may change *where* the command runs,
  never what it is. Chain with `&&` or split into tasks wired by
  `dependsOn` so each step caches on its own.
- **Project boundaries are hard.** A glob never crosses into another
  project's directory. What one project needs from another arrives
  through the graph, as an upstream task's outputs.

## What is not inside

The list below is not a roadmap gap. It is a boundary, and it is in the
repository's memory file so nobody re-proposes it by accident:

- **No cloud, no account, no dashboard.** vx does not know your
  organisation exists.
- **No daemon.** Every run pays its own discovery and still answers a
  fully cached 3,270-task graph in about half a second.
- **No auto-inferred inputs.** A traced read set describes what a task
  read once, on one machine, after the fact. A key is needed before the
  task runs. You declare inputs, and the sandbox lets you enforce the
  declaration.
- **No JavaScript-function tasks.** The shell is the API. Your tools stay
  yours.
- **No named inputs, no global inputs, no global env.** Configs are
  TypeScript. A shared preset is an import and a spread.
- **Nothing distributed in the core repository.** Remote caches, remote
  execution, telemetry sinks, agent protocols, GitHub summaries are all
  plugins in their own packages. `@vzn/vx-reapi` (Bazel Remote Execution
  API) is the proof the seams are wide enough to build those on.

## Why the boundary matters

A tool that owns the cloud has an incentive to make the local path
merely adequate. A tool that owns nothing but the graph has one job:
be correct and be fast on the machine in front of you. Everything that
follows in this series is a consequence of that job. The next post is
about the fast part.

Where to look next: the [Quickstart](../../quickstart/), the
[Architecture](../../architecture/) page, and the
[comparison](../../comparison/) with Turborepo, Nx and vite-task.
