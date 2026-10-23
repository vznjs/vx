---
title: 'Cache transfers wait on the network'
date: 2026-10-20T18:10:00Z
authors:
  - vzn
tags:
  - caching
  - performance
excerpt: 'A download from a remote cache is a wait on a round trip, not work for a core. vx sizes each transfer lane on its own: 1,000 uploads to a cache 30 ms away take 2.5 s.'
---

1,000 tasks, a remote cache 30 ms away, and one flag changed:

```sh frame="terminal"
$ time vx run build --all --cache-concurrency-upload 4
  cache     remote 1000↑ 269 KB
  time      2.27s
real    0m8.345s

$ time vx run build --all
  cache     remote 1000↑ 269 KB
  time      2.38s
real    0m2.649s
```

The run's own `time` ends with its last task. Uploads drain in the
background after that, and the process exits when they are done.

Each upload sends a request and waits a round trip. Four at once leaves
a 4-core machine waiting on the network; 64 at once does not.

| Lane limit       | Upload all 1,000 | Restore all 1,000 from the remote |
| ---------------- | ---------------- | --------------------------------- |
| 1                | 31.6 s           | 9.0 s                             |
| 4                | 8.4 s            | 8.4 s                             |
| 16               | 2.7 s            | 2.6 s                             |
| default (64)     | 2.5 s            | 1.6 s                             |

Min of 3 interleaved runs each. `private/vx-bench/generate.ts` with
1,000 projects, `build --all`, a Turborepo-protocol cache server that
answers every request after 30 ms, `turboCache()` from
`@vzn/vx-migrate`, `CI=1` so uploads are on. Linux x64, 4 cores, vx at
`a1786b3`, 2026-10-23.

## Three lanes, three limits

| Lane       | Default                                 | Why                                      |
| ---------- | --------------------------------------- | ---------------------------------------- |
| `download` | min(96, max(cores × 3, 64))             | mostly waiting on the network            |
| `upload`   | min(96, max(cores × 3, 64)), per remote | the same, and it runs in the background  |
| `restore`  | twice `run.concurrency`                 | local disk work, closer to a task        |

The network formula is the one pnpm uses for its own fetches: at least
64 at once, even on a small machine, and at most 96.

A server that wants fewer connections gets fewer. Each limit is a
setting, a flag and an env var:

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

Before a run starts its tasks, it asks each remote in one batch which
of its keys exist. A task that needs its key before that answer waits
for the batch. A key the remote lacks costs nothing beyond the batch;
a key it holds costs one download.

## One request per plugin read

Plugins keep their own entries in the same cache, such as the run
timings `@vzn/vx-schedule-history` learns from. `ctx.cache.get`, `has`
and `hasMany` make one request: the branch's entry by default, or the
default branch's when the plugin passes `false`.

Settings: [schema](../../schema/). Flags: [CLI reference](../../cli/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
