---
title: 'When running beats downloading'
date: 2026-10-21T18:10:00Z
authors:
  - vzn
tags:
  - caching
  - performance
excerpt: 'A remote cache hit used to wait for its whole download, even when the task itself would have finished first. How vx now weighs each download against the task it replaces, gives up a slow one, and runs the task here instead.'
---

A remote cache hit is supposed to save time. Usually it does: the task
takes seconds, its outputs come down in milliseconds. But a large
artifact on a slow link can take longer to download than the task takes
to run. vx used to wait for the whole body anyway, because a hit was a
hit.

## Weigh the download against the task

A remote that says how big an entry is and how long its task took lets
vx do the sum. Turbo's cache API sends both, in its batch query and on
`HEAD` (`Content-Length` and `x-artifact-duration`), so `turboCache()`
passes them on.

While a task waits on its download, vx checks the body's pace every
25 ms. When the rest of the body would take longer than twice the task's
stored run time, it gives the download up and runs the task here. Twice,
because a run here also has to save its outputs. The task counts as a
miss and uploads nothing: the remote already holds the key.

A remote that does not say the size or the time is awaited as before. A
guess could only make a hit slower or a run wasted.

## What it changed

500 tasks, a remote 30 ms away serving 4 MB/s per connection, 20 of the
entries 8 MB each. A full run went from 3,070 ms to 1,807 ms (min of 5
runs, before and after the change). With 200 tiny tasks, where every
download beats its task, the two tie.

## Know what a run will pull

The footer now says how many bytes each remote direction moved, and
`--dry` says what restoring the remote hits would download before
anything runs:

```sh frame="terminal"
$ vx run build --all --dry
500 task(s) planned, 500 cache hits (500 remote, 157 MB).
$ vx run build --all
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 19↑ · remote 481↓ 12 MB
```

Here 19 large entries came down slower than their tasks run, so those 19
ran here (`local 19↑`), and the other 481 came from the remote.

## For plugin authors

A remote's `has` now answers what it knows of an entry instead of a
boolean: `{ size, durationMs }`, either one, `{}`, or `null` for a key
it lacks. `hasMany` answers a `Map` of the held keys to the same. Any
backend that can say a size gets the `--dry` figure, and one that can
also say a duration gets the slow-download check.
[Your own cache](../../guides/plugins/#your-own-cache) shows a whole
remote.

Remote caches are set up in [CI and remote](../../guides/ci/#remote-cache).
More on vx at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
