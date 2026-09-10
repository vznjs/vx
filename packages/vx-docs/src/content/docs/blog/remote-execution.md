---
title: 'Remote execution without moving the scheduler'
date: 2026-09-10T23:38:00Z
authors:
  - vzn
tags:
  - plugins
  - remote-execution
excerpt: "@vzn/vx-reapi runs tasks on any Bazel Remote Execution API worker pool. The graph, the placement decision, retries, timeouts and the cache all stay on your machine; what moves is one self-contained action per task."
---

Distributed builds usually arrive as a platform: a service that owns
the graph, agents that run it, a dashboard that shows it. vx's version
is a plugin that fills two seams, `executor` and `cache`, against a
wire that already exists: Bazel's Remote Execution API, spoken by
NativeLink, BuildBuddy, Buildfarm and bazel-remote.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [
    reapi({
      endpoint: 'grpcs://cache.example.com:443',
      execute: true,
      platform: { OSFamily: 'Linux', 'container-image': 'docker://node:22' },
      capacity: 64,
    }),
  ],
})
```

Execution is off unless `execute: true` is set, even with the plugin
declared for caching. Changing where a build runs is not something a
plugin should do by being present.

## The scheduler never leaves

vx owns the task graph and decides placement once per task, before
scheduling. Telemetry, retries, timeouts, the cache and the logger
behave exactly as they do locally, because none of them moved. The
executor's job is one function: run this command with these inputs and
give me the outputs. `capacity` gives it its own scheduler pool, so a
64-wide fleet is not throttled by a laptop's core count and remote
tasks reserve none of the local CPU budget.

`vx run --dry` prints the decision per line: `@vx/reapi`, `@local` or
`@noop`.

## What goes remote

- **Only cacheable tasks.** A task with no `cache` block has no
  declared inputs, so a worker would run it against an empty tree.
- **Not persistent tasks, or anything depending on one.** A worker
  cannot reach a port on your machine; the placement stage knows.
- **Not sandboxed tasks.** The sandbox is local machinery a worker does
  not have, and a boundary verified remotely would pass vacuously.
- **Not `exec.remote: false`.** A task that talks to Docker, a device
  or a local daemon is pinned by one field.

A task's inputs on the worker are exactly what its cache key declares:
`cache.inputs.files`, resolved env values, upstream outputs. Ambient
state such as an undeclared `tsconfig.json`, `.npmrc` or
`node_modules` is not in the key and therefore not on the worker. The
[sandbox](../the-sandbox/) is how you find the gap before you mark a
task remote-eligible: a task that passes locally with the declared
paths as its only reads will pass on a worker.

## `node_modules`: install as an action

Workers are stateless and `node_modules` is ambient. The answer is an
explicit install task pinned to the pool with `exec.remote: 'only'`:

```ts
install: {
  exec: { command: 'pnpm install --frozen-lockfile', remote: 'only' },
  cache: {
    inputs: { files: ['package.json', 'pnpm-lock.yaml'] },
    outputs: { files: ['node_modules/**'] },
  },
},
build: {
  dependsOn: ['install'],
  exec: { command: 'tsc -p .' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
},
```

Verified end to end against a live NativeLink pool: `install` runs on a
worker, once per lockfile change, and its outputs never touch your
disk. A dependent's input tree references the install outputs in the
remote content-addressed store, so the bytes flow worker to store to
worker without transiting your machine. With no remote executor
declared, `install` is a local no-op and dependents use whatever your
machine has, so a laptop run behaves as it did before the field
existed.

## One artifact format, both directions

The same `tar.zst` bytes serve the local cache and the remote's
action cache. Nothing is repacked at the boundary. A remote error, a
timeout, an unreachable endpoint all degrade to a miss on that layer
and the run continues locally; a cache-only server that advertises no
execution capability declines the executor with a warning and keeps
serving the cache.

None of this is in core. Core has the two seams and the placement
stage; `@vzn/vx-reapi` is the proof they are wide enough. The guide,
including worker image requirements and how output globs travel over a
wire that has no globs, is [Remote
execution](../../guides/remote-execution/).
