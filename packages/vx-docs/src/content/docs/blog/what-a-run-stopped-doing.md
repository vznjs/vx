---
title: 'Three things a run stopped doing'
date: 2026-10-20T18:30:00Z
authors:
  - vzn
tags:
  - performance
  - design
excerpt: 'A fast run is mostly a run that skips work. Three jobs vx used to do on every run, and why each one went: housekeeping at exit, a walk of the shared store, and a "saved" figure that overstated what the cache saved.'
---

Most of what makes a warm run fast is work it does not do. Recent
releases took three jobs out of every run. None of them made a run
wrong; each one made every run pay for something it did not need.

## Housekeeping at exit

Every run ended by tidying up: it deleted run history and hash memos
older than 30 days, then applied the workspace's retention policy to the
cache. That was seven `DELETE`s, four of them full scans, and their cost
grew with history. At 100,000 rows of history it was 16.7 ms of a run's
end, against 5.4 ms without it.

A run now ends without any of it. Cleanup is one command, run when you
choose, from a cron job or a scheduled CI workflow:

```sh frame="terminal"
vx cache clean --older-than 30d --max-size 10G
```

`cache.retention` went with it: one cleaner is easier to reason about
than a policy that fires at the end of whichever run happens to be next.

## A walk of the shared store

Every run opened the shared store under `~/.vx` and, because the open
looked for the wrong index file name, took it for a store it had never
seen. It then checked each entry's directory for 14 manifest names:
14,000 file system calls at 1,000 stored entries, on every run,
no-op runs included. The fix was one file name, and an existing store
now opens without the walk.

## A "saved" figure

The footer's `time` row used to end with `Xs saved`: the stored run time
of every cache hit, added up. Hits that would have run side by side cost
the wall clock once, so the sum said more than the cache saved. A number
that flatters is worse than no number, so the row now says only what was
measured:

```txt frame="terminal"
  time      2.31s · max 1.20s · min 40ms
```

What each run still does, stage by stage, is in
[Architecture](../../architecture/). More on vx at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
