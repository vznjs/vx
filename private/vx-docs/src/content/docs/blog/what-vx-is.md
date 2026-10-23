---
title: 'What vx is, and what it refuses to be'
date: 2026-09-10T23:59:00Z
authors:
  - vzn
tags:
  - announcement
  - design
excerpt: 'vx is task orchestration you own: it runs and caches a task graph, correctly, and nothing else. The stages, the seams, and what will never be inside.'
---

**vx runs and caches a task graph, correctly, and stops there.** That
sentence is a design. Here is what it commits us to.

## A run is a pipeline

1. **Lock.** `vx lock` finds every project, evaluates each
   `vx.config.ts` and writes `.vx/projects.lock.json`. A run reads only
   the lock.
2. **Graph.** One task graph for the whole workspace, from `dependsOn`
   and the package graph.
3. **Key.** Each task gets a content hash of its declared inputs, its
   evaluated config and the keys of everything upstream.
4. **Schedule.** Look each key up. Restore hits. Run misses. Save.

In plugin terms the stages are named `config` → `discover` →
`project` → `graph` → `key` → `fingerprint` → `schedule` → `admit`, then
`executor`, `cache`, `telemetry`, `output`, `setup`, `teardown` and
`commands`. Each is a seam a plugin can fill.

Core applies **no** plugin by default. Running here and
caching here are the floor, so a workspace with no plugins still works.

## A task is one command

```ts
build: {
  exec: { command: 'tsc -b' },
  inputs: { files: ['src/**', 'tsconfig.json'] },
  cache: { outputs: { files: ['dist/**'] } },
}
```

Three rules hold everywhere:

- **Caching is opt-in.** No `cache` block, no cache. vx never guesses
  what a task reads.
- **One command per task.** A plugin may change *where* it runs, never
  *what* it is.
- **Project boundaries are hard.** A glob never reaches into another
  project. What one project needs from another comes through the graph.

## What is not inside

| Never in vx                     | Why                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| A cloud, account or dashboard   | vx does not need to know your company exists.                       |
| A daemon                        | A second copy of the truth can go stale. Git is read fresh per run. |
| Inferred or traced inputs       | A trace says what a task read once. A key is needed before it runs. |
| JavaScript-function tasks       | The shell is the API. Your tools stay yours.                        |
| Named, global inputs or env     | Configs are TypeScript. A shared preset is an import.               |

Remote caches, remote execution, telemetry and CI summaries are plugins
in their own packages. `@vzn/vx-reapi` (Bazel's Remote Execution API)
proves the seams are wide enough.

## Why the boundary matters

A tool that sells a cloud has a reason to keep the local path merely
fine. A tool that owns only the graph has one job: be correct and fast
on the machine in front of you.

Next: [Why vx is fast](../why-vx-is-fast/). Reference:
[Architecture](../../architecture/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
