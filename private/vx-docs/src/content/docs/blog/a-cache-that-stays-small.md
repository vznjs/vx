---
title: 'A cache that stays the size you chose'
date: 2026-10-10T12:00:00Z
authors:
  - vzn
tags:
  - caching
excerpt: 'A build cache only grows unless something takes entries out. How vx evicts by age and by size, what it does with files no index knows, and why it refuses a bound of zero.'
---

A store of 1,000 entries, 94 MB, capped at 50 MB:

```sh frame="terminal"
$ vx cache clean --max-size 50M --dry-run
› vx cache clean  would free 44 MB (dry run)

  467 entries

$ vx cache clean --max-size 50M
✓ vx cache clean  freed 44 MB

  467 entries
```

The dry run names the victims and stops. The real clean with the same
flags removes exactly those. Demo workspace of 1,000 projects, vx at
`22f6eb7`, 2026-10-23.

## Two policies: age, then size

| Flag            | Evicts                                                     |
| --------------- | ---------------------------------------------------------- |
| `--older-than`  | entries nobody used for that long; a hit counts as a use   |
| `--max-size`    | least recently used entries, until the store fits          |

Use either or both. Age goes first: whatever nobody asked for in a month
is unlikely to be asked for tomorrow.

Durations take `s`, `m`, `h` and `d` (`30d`, `24h`). Sizes take `K`,
`M`, `G` and `T` in powers of 1024, with an optional `B` or `iB` (`500M`,
`1gb`, `32KiB`).

A size cap below what one full build saves evicts that build's own
entries. Set it above. `vx info` shows where you stand:

```sh frame="terminal"
$ vx info
  cache entries     1000 (94 MB)
```

## Run it on a schedule

No run evicts anything. Put the clean where it runs on its own, in a
cron job or a scheduled CI workflow:

```sh frame="terminal"
vx cache clean --older-than 30d --max-size 10G
```

## A bound of zero is refused

```sh frame="terminal"
$ vx cache clean --max-size 0
✗ vx cache clean  --max-size 0 would evict every entry — `vx cache clean` with no bound clears the whole cache

$ vx cache clean --max-size 10
✗ vx cache clean  --max-size 10 would read as 10 bytes and evict nearly everything — give a unit (e.g. 10M, 10G)
```

A zero, or a bare number, is far more often a value computed by mistake
than an intent. To clear everything, run `vx cache clean` with no bound:
it clears this repository's store and the workspace's run history, and
`--global` clears every repository's store.

## Files no index knows

The cache is an index (rows in SQLite) and the entries beside it. They
can drift apart: a cache format change resets the index and leaves the
entries, and a save that crashed leaves a temp file. vx calls these
orphans, and every clean sweeps for them.

An orphan is judged by its file time, because another vx version
sharing the store may still read it. Nothing younger than an hour is
taken, and only names vx writes are touched: a `release.tar.zst` you
keep in a shared cache directory is never deleted. An entry deleted by
hand loses its index row at the next clean, and its bytes count toward
neither the cap nor the freed total.

## For scripts and agents

```sh frame="terminal"
$ vx cache clean --max-size 50M --dry-run --format json
{"dryRun":true,"evicted":467,"bytesFreed":45907968,"orphans":0,"orphanBytes":0}
```

A clean that deletes waits for a `vx run` on the same workspace to
finish, so it never evicts an entry that run is restoring. A run it
cannot see, such as another workspace sharing the cache directory, is
still safe: an entry that disappears before its restore is a miss, and
the task runs.

Reference: [`vx cache clean`](../../cli/cache/) and the
[schema](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
