---
title: 'When running beats downloading'
date: 2026-10-21T18:10:00Z
authors:
  - vzn
tags:
  - caching
  - performance
excerpt: 'A remote hit should not wait for a download that takes longer than the task. vx weighs each download against the task it replaces, gives up a slow one and runs the task here.'
---

500 tasks, all of them remote hits. 20 entries are 8 MB each, on a link
that serves 4 MB/s per connection:

```sh frame="terminal"
$ vx run build --all --dry
500 task(s) planned, 500 cache hits (500 remote, 153 MB).

$ vx run build --all
  cache     local 20↑ · remote 480↓ 129 KB
  time      1.02s
```

The 20 large entries would take 2 s each to come down. Their tasks run
in milliseconds, so vx ran those 20 here (`local 20↑`) and took the
other 480 from the remote.

| The remote says               | Full run | Downloaded |
| ----------------------------- | -------- | ---------- |
| size and task time            | 1.15 s   | 129 KB     |
| size only                     | 3.12 s   | 153 MB     |

Min of 3 interleaved runs, local cache empty, outputs deleted.
`private/vx-bench/generate.ts` with 500 projects, 20 of them writing
8 MB of random bytes. A Turborepo-protocol stub 30 ms away that streams
bodies at 4 MB/s, read through `turboCache()`. Linux x64, 4 cores, vx
at `22f6eb7`, 2026-10-23.

## Weigh the download against the task

A remote that says how big an entry is and how long its task took lets
vx do the sum. Turbo's cache API sends both, in its batch query and on
`HEAD` (`Content-Length` and `x-artifact-duration`), so `turboCache()`
passes them on.

While a task waits on its download, vx checks the body's pace every
25 ms. When the rest of the body would take longer than twice the
task's stored run time, it gives the download up and runs the task
here. Twice, because a run here also has to save its outputs. The task
counts as a miss and uploads nothing: the remote already holds the key.

A remote that does not say the time is awaited, as in the second row.
A guess could only make a hit slower or a run wasted.

## Know what a run will pull

The footer says how many bytes each remote direction moved, and `--dry`
says what restoring the remote hits would download before anything
runs, as above.

## For plugin authors

A remote's `has` answers what it knows of an entry: `{ size, durationMs }`,
either one, `{}`, or `null` for a key it lacks. `hasMany` answers a
`Map` of the held keys to the same. Any backend that can say a size gets
the `--dry` figure, and one that can also say a duration gets the
slow-download check. [Your own cache](../../guides/plugins/#your-own-cache)
shows a whole remote.

Setup: [Remote cache](../../guides/ci/#remote-cache). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
