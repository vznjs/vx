---
title: 'A cache that stays the size you chose'
date: 2026-10-10T12:00:00Z
authors:
  - vzn
tags:
  - caching
excerpt: 'A build cache only grows unless something takes entries out. How vx evicts by age and by size, what it does with files no index knows, and why it refuses a bound of zero.'
---

Every cache miss in a monorepo adds an entry: the outputs of one task,
packed and stored under its key. Nothing in that loop ever takes one out.
Left alone, a busy repository's cache grows until the disk is full. vx
gives you two ways to bound it and does the cleanup it can do on its own.

## Two policies: age, then size

```sh frame="terminal"
$ vx cache clean --older-than 30d
✓ vx cache clean  freed 1.3 GB

  42 entries

$ vx cache clean --older-than 7d --max-size 500M
✓ vx cache clean  freed 320 MB

  18 entries
```

`--older-than` drops entries nobody has used for that long. A hit
counts as a use, so an entry your builds keep restoring stays however
old it is. `--max-size` is a cap: once the age rule has run, vx evicts
the least recently used entries until the store is under the size you
gave. Use either or both. Age goes first because it is the cheap,
obvious win: whatever nobody asked for in a month is unlikely to be
asked for tomorrow.

Durations take `s`, `m`, `h` and `d` (`30d`, `24h`). Sizes take `K`,
`M`, `G` and `T` in powers of 1024, with an optional `B` or `iB` (`500M`,
`1gb`, `32KiB`).

## Set it once, forget it

The same policy can run by itself. Declare it in `.vx/workspace.ts`:

```ts title=".vx/workspace.ts"
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  cache: { retention: { olderThan: '30d', maxSize: '10GB' } },
})
```

At the end of every run, after its saves and uploads have landed, vx
applies that policy. It prints nothing: housekeeping is not the run's
news. A run with nothing to evict pays one scan of the index. A
cleanup that fails is silent and never fails the run, and a run stopped
by Ctrl-C or an abort skips it.

One thing to know about the size cap: it is least recently used first,
so a `maxSize` smaller than one run's outputs evicts that run's own
entries. Set it above what a full build saves.

`vx info` shows where you stand, as `812 (3.0 GB of 10 GB, 30%)`, and
what each run's end will evict.

## Files no index knows

The cache is two things: an index (rows in SQLite) and the artifacts
beside it (`<hash>.tar.zst`). They can drift apart. A cache format
change resets the index and leaves the artifacts. A save that crashed
leaves a temp file it never renamed. vx calls these orphans.

Every clean also sweeps for them. An orphan is judged like an entry, by
its file time, because another vx version sharing the store may still
read it. A run that asks for an orphan's key indexes it again from its
bytes and gets a hit; one no task asks for again is only reclaimed by
the sweep. Nothing younger than an hour is taken, and only names vx
writes are touched: a `release.tar.zst` you keep in a shared cache
directory is never deleted.

The reverse drift is handled too. If you delete an artifact by hand,
its index row goes with the next clean, and its bytes count toward
neither the size cap nor the freed total, because they are on no disk.

## A bound of zero is refused

```sh frame="terminal"
$ vx cache clean --max-size 0
```

That would evict every entry, and a zero is far more often a value
computed by mistake than an intent. The same goes for a bare number:
`--max-size 10` would mean ten bytes, so vx asks you to write `10G`, or
`10B` if bytes really are the unit. When you really want the cache
gone, run `vx cache clean` with no bound: it clears this repository's
store and the workspace's run history, and `--global` clears every
repository's store.

## Try it before it deletes anything

```sh frame="terminal"
$ vx cache clean --older-than 30d --dry-run
› vx cache clean  would free 1.3 GB (dry run)

  42 entries · 3 orphaned artifacts
```

`--dry-run` picks the victims under the same policy and stops there.
The real clean with the same flags removes exactly what it named. Add
`--format json` for a script or an agent; it prints
`{ dryRun, evicted, bytesFreed, orphans, orphanBytes }`.

A clean that deletes also waits for a `vx run` on the same workspace to
finish, so it never evicts an entry that run is restoring. A run it
cannot see, such as another workspace sharing the cache directory, is
still safe: an artifact that disappears before its restore is a miss,
and the task runs.

The full reference is in the
[CLI docs](https://vznjs.github.io/vx/cli/#vx-cache-clean) and the
[workspace schema](https://vznjs.github.io/vx/schema/).
