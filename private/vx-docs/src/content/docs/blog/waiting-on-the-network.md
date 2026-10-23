---
title: 'Cache transfers wait on the network'
date: 2026-10-20T18:10:00Z
authors:
  - vzn
tags:
  - caching
  - performance
excerpt: 'Downloads from a remote cache used to run only as many at once as the run had workers, and uploads four at once. A transfer is a wait on a round trip, not work for a core. How vx now sizes each lane on its own, and why a missing key costs no request.'
---

A task needs a core. A download from a remote cache mostly needs
patience: it sends a request and waits a round trip for the answer.
vx used to run downloads only as many at once as the run had workers,
and uploads four at once. On a 4-core runner talking to a cache 30 ms
away, that left the run waiting on round trips while the machine sat
idle.

## Three lanes, three limits

Downloads, uploads and local restores now each have their own limit:

| Lane | Default | Why |
| --- | --- | --- |
| `download` | min(96, max(cores × 3, 64)) | mostly waiting on the network |
| `upload` | min(96, max(cores × 3, 64)), per remote | the same, and runs in the background |
| `restore` | twice `run.concurrency` | local disk work, closer to a task |

The formula for the network lanes is the one pnpm uses for its own
fetches: at least 64 at once, even on a small machine, and at most 96.

On a remote 30 ms away with 1,000 tasks, uploading every entry went
from 9.4 s to 3.8 s, and restoring every entry from the remote from
5.1 s to 2.6 s (min of 3 runs each).

Each limit is a setting, a flag and an env var, so a server that wants
fewer connections gets fewer:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  cache: { concurrency: { download: 32, upload: 16 } },
})
```

```sh frame="terminal"
vx run build --all --cache-concurrency-upload 16
```

## A missing key costs no request

Before a run starts its tasks, it asks each remote in one batch which of
its keys exist. A task that looked up its own key before that answer
came back used to send its own request anyway, even for a key the batch
was about to report missing. Now the task waits for the batch. A key the
remote does not have costs nothing beyond the one batch, and a key it
does have costs one download.

## One request per plugin read

Plugins keep their own entries in the same cache, such as the run
timings `@vzn/vx-schedule-history` learns from. On a branch, a plugin
read used to ask the default branch's entry and then the branch's. Now
`ctx.cache.get`, `has` and `hasMany` make one request: the branch's entry
by default, or the default branch's when the plugin passes `false`.

The settings are in the [schema](../../schema/), and the flags in the
[CLI reference](../../cli/). More on vx at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
