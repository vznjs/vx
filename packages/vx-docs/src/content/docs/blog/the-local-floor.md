---
title: 'The local floor: running here is not a plugin'
date: 2026-09-10
authors:
  - vzn
tags:
  - design
  - plugins
excerpt: "Every executor list ends with this machine. Every cache chain ends with .vx/cache. That is the one thing core does without being told, and it is what lets a plugin decline a task and hand it back instead of failing the run."
---

A pipeline that applies no plugin by default has to answer one
question honestly: what happens with no plugins at all? For vx the
answer is that the workspace runs and caches exactly as it would with
a full workspace file, because the local executor and the local cache
are not plugins. They are the **floor**.

## Two lists, one tail

When vx places a task, it walks the executor list from
`vx.workspace.ts` in declaration order and asks each one whether it
will take the task. When vx looks a key up, it walks the cache layers
in order. Both lists have the same implicit last element:

```
executors: [ reapi, …, local ]
cache:     [ turboCache, …, .vx/cache ]
```

You never write the last element and you cannot remove it. A workspace
with no `vx.workspace.ts` is the empty list plus the floor, which is
why `vx run build` works in a fresh repository with one `vx.config.ts`
and nothing else.

## Declining is a first-class outcome

Because the floor is always there, a plugin is allowed to say no. That
turns a lot of would-be failure modes into placement decisions:

- A remote executor declines a task that has no `cache` block (a
  worker would run it against an empty tree). It runs here.
- A remote executor declines a persistent task and everything that
  depends on it, because a worker cannot reach a port on your laptop.
  They run here.
- A sandboxed task declines remote placement: the sandbox is local
  machinery a worker does not have, and a boundary verified remotely
  would pass vacuously. It runs here, inside the sandbox.
- A remote cache that errors, times out or is simply unreachable
  degrades to a miss on that layer, and the lookup continues down the
  chain to the local cache. A remote outage is a slower run, not a
  broken one.
- `@vzn/vx-reapi` against a server that only advertises caching
  declines the executor with a warning; the cache layer still works.

`vx run --dry` shows the decision per line: `@vx/reapi`, `@local`, or
`@noop` for a task with nothing to execute.

## Why it is the floor and not a default plugin

It would have been easy to ship `localExecutorPlugin()` and
`localCachePlugin()` and prepend them when the list is empty. That
design has a hole: a list that is *not* empty would have no floor
unless the user remembered to append them, and a plugin that declined
would have nowhere to hand the task. Making local behaviour the tail of
every list instead of a member means the "no plugin" case and the
"plugin declined" case are the same case, and there is no configuration
in which a task has nowhere to run.

It also keeps the principle intact. Core names no plugin. What it
names is a machine and a directory, which is not a capability anyone
supplies. Everything above the floor, including the wire a remote cache
speaks, is declared in the workspace file or it does not exist.
