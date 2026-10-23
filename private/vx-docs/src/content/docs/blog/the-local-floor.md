---
title: 'The local floor: running here is not a plugin'
date: 2026-09-10T23:40:00Z
authors:
  - vzn
tags:
  - design
  - plugins
excerpt: "Every executor list ends with this machine. Every cache chain starts with the local cache. That is the one thing core does without being told, and it is what lets a plugin decline a task and hand it back instead of failing the run."
---

Point a remote cache at a port nothing listens on and run a build:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [turboCache({ apiUrl: 'http://127.0.0.1:9', token: 'demo' })],
})
```

```sh frame="terminal"
$ vx run build --all
[vx] plugin '@vzn/vx-migrate': probe of 4 artifacts at http://127.0.0.1:9/v8/artifacts failed: ECONNREFUSED: Unable to connect. Is the computer able to access the url?

 ⏺︎     7ms success miss     packages/c#build
 ⏺︎    19ms success miss     packages/b#build
 ⏺︎    22ms success miss     packages/a#build
 ⏺︎    17ms success miss     packages/d#build
[vx] plugin '@vzn/vx-migrate': 4 more requests failed the same way: ECONNREFUSED: Unable to connect. Is the computer able to access the url?
  …
  tasks     4 success · 4 total
  cache     remote 4✗
$ echo $?
0

$ vx run build --all
  …
  tasks     4 success · 4 total
  cache     local 4✓
  time      20ms
```

The remote is down. The run is green, warns once, and the second run
hits the local cache. Linux x64, vx at `0be0367`, 2026-10-23.

That works because running here and caching here are not plugins. They
are the **floor**.

## Two lists, one floor

```
executors: [ reapi, …, local ]
cache:     [ local cache, turboCache, … ]
```

- **Where a task runs.** vx asks each executor from `.vx/workspace.ts`
  in order. This machine is always last.
- **Where a key is looked up.** The local cache is always first, then
  each remote in declared order. A save reaches every remote.

You never write the local element and can't remove it. A workspace
file with no plugins is the empty list plus the floor, so `vx run
build` works in a fresh repository with that file and one
`vx.config.ts`.

The floor's artifacts live in `~/.vx/<id>/cache`, shared by every
checkout of the repository; each workspace keeps its own index in
`.vx/cache`. See [the shared store](../../caching/#storage-layout).

## A plugin may say no

With the floor always there, declining is a placement decision, not a
failure:

| Case                                         | Runs where       |
| -------------------------------------------- | ---------------- |
| task with no `cache` block                   | here             |
| persistent task, and what depends on it      | here             |
| sandboxed task, and what depends on it       | here, sandboxed  |
| remote cache errors or times out             | miss on that layer, warning |
| REAPI server that only offers caching        | executor declines, cache works |

A worker runs against an empty tree, can't reach a port on your laptop
and has no sandbox, so those tasks stay. `vx run --dry` prints the
choice per line once more than one executor is declared:
`@vx/reapi`, `@local`, or `@noop` for an `exec.remote: 'only'` task no
remote takes, which the run skips.

## Why not a default plugin

Shipping `localExecutorPlugin()` and prepending it to an empty list
leaves a hole: a list that is *not* empty has no floor unless you
remember it, and a declined task has nowhere to go. As part of every
list, "no plugin" and "plugin declined" are the same case. No
configuration leaves a task with nowhere to run.

Core still names no plugin. It names a machine and a directory.
Everything above the floor, including the wire a remote cache speaks,
is declared in the workspace file or doesn't exist.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
