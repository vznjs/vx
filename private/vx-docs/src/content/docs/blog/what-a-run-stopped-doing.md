---
title: 'What a run does not do'
date: 2026-10-20T18:30:00Z
authors:
  - vzn
tags:
  - performance
  - design
excerpt: 'A fast run is mostly a run that skips work. A vx run does no housekeeping at exit, no walk of the shared store, and claims no "saved" time it did not measure.'
---

Most of what makes a warm run fast is work it does not do. Three jobs
stay out of every vx run.

## No housekeeping at exit

A run ends when its last task does. Deleting old run history, old hash
memos and cache entries past a size is one command, run when you choose,
from a cron job or a scheduled CI workflow:

```sh frame="terminal"
$ vx cache clean --older-than 30d --max-size 10G
› vx cache clean  nothing to free

$ vx cache clean --max-size 100K
✓ vx cache clean  freed 94 MB

  999 entries
```

Cleanup at the end of every run would be seven `DELETE`s, four of them
full scans, with a cost that grows with history. One cleaner you run
is easier to reason about than a policy that fires at the end of whichever run
happens to be next, so there is no `cache.retention` setting.

## No walk of the shared store

The shared store under `~/.vx` opens by its index file. A run never
lists the store's entries or checks their directories.

## No "saved" figure

The footer's `time` row says only what was measured: the wall time, and
the slowest, average and fastest task.

```txt frame="terminal"
  time      1.86s · max 23ms · avg 5ms · min 3ms
```

A sum of the stored run time of every hit would say more than the
cache saved: hits that would have run side by side cost the wall clock
once. A number that flatters is worse than no number.

What each run does, stage by stage, is in
[Architecture](../../architecture/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
