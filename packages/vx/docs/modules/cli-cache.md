# `src/cli/cache.ts` — `vx cache clean`

## Purpose

Implements `vx cache clean`, which trims with a bound and clears with
none. Both parsers are `util/size.ts`'s,
re-exported here. Drives
`Cache.prune({...})` from `src/cache/cache.ts` against the cache
directory a run would use.

## Public surface

```ts
export async function cacheCmd(args: readonly string[]): Promise<number>

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  dry?: boolean
  format?: 'pretty' | 'json'
  cacheDir?: string // `--cache-dir`: prune the cache a run with the same flag uses
  global?: boolean // `--global`: with no bound, clear every ~/.vx/*/cache too
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs
export interface ClearResult {
  dry: boolean
  cleared: string[]
  bytesFreed: number
}
export { parseDuration, parseSize } from '../util/index.js'
// util's treeBytes (bytes on disk under a path) sizes a clear and `vx info`'s rows
```

## Subcommand surface

```
vx cache clean --older-than <duration>
vx cache clean --max-size <size>
vx cache clean --older-than 7d --max-size 500M   # both
vx cache clean --max-size 1G --dry               # say what the policy would reap; delete nothing
vx cache clean --max-size 1G --format json       # schemas/cache.json
vx cache clean --older-than 30d --cache-dir <path>
vx cache clean                                   # no bound: clear the cache
vx cache clean --global                          # and every repo's store
```

Neither bound may be zero — a policy that would evict every entry is
refused with "`vx cache clean` with no bound clears the whole cache". A bare number for `--max-size`
is refused too: `--max-size 10` would read as ten bytes and evict
nearly everything; give a unit. Both policies may be combined:
age-based eviction first, then LRU eviction if the total is still
over the size cap. The prune also reaps orphaned artifacts (an archive
with no index row) and stale temps, and says so — `✓ vx cache clean  freed 1.4 GB`, then `12 entries · 3
orphaned artifacts`; a dry run says `would free 1.4 GB (dry run)`.

The directory is the one a run would use — `--cache-dir`,
`defineWorkspace({ cache: { dir } })` and a `config` plugin's edit of it,
through `cliCacheDir` — or a prune silently no-ops against the wrong
path. So is the store: with `.vx/cache` deleted the prune still opens
the store a run would (`resolveStoreRoot`), where it once said 0 while
every entry stayed restorable (X-17); `vx info` reads it the same way. A cache this user cannot write is refused up front with the
directory named, as a run refuses it (a dry run only reads, and reads
a read-only cache fine), and an upgrade that reset the index is
announced once. A prune that deletes takes the workspace's run lock
first (`acquireRunLock`, orchestrator.md), so it waits for a run on the
workspace — `[vx] waiting for another vx run (pid N) on this workspace
to finish…` after a second — instead of evicting the hits that run has
just probed; the age cutoff is taken before the wait, so what the run
touched survives it. A dry run takes no lock.

## No bound: clear

With neither bound, deletes the cache directory a run would use (`.vx/cache`, `cache.dir`,
`--cache-dir`) when it holds a `cache.db`, and the store that index
records (`Cache.storeDir`, else `resolveStoreRoot`): the entries live
in `~/.vx/<id>/cache`. A target that is `.vx` or holds it (the
workspace config, the lock, `.vx/.gitignore`) is refused. A cache
directory other than `.vx/cache` is the user's: only `vxCacheEntries`
(the index and its WAL, `VX_ARTIFACT_NAME` files, `runs/`, `failures/`,
`lockfile-claims/`, `compiled/`, an unchanged `*` `.gitignore`) go, then the
directory if empty (item 968). The size is
summed before the delete (links not followed); the delete takes the run
lock, as a prune does. `--dry` deletes nothing and takes no lock.
`--global` adds every `~/.vx/*/cache` and is refused with a bound or
`--cache-dir`. The output says the store is shared by the repo's
checkouts and that run history goes.

## Parsers

### `parseDuration(input): number | null`

```
/^(\d+)(ms|[smhd])$/i
```

Returns ms. `s` (× 1000), `m` (× 60_000), `h` (× 3_600_000), `d`
(× 86_400_000), case-insensitively (`30D` is thirty days). `null` on
parse fail; the caller surfaces `--older-than must be a duration like 30d, 24h or 60m (got <value>)`.

### `parseSize(input): number | null`

```
/^(\d+)(?:([KMGT])(?:i?B)?|B)?$/i
```

Returns bytes. Multipliers are powers of 1024 (`K`, `M`, `G`, `T`), with an optional `B` or `iB` (`32KiB`).
Optional trailing `B` is allowed. `null` on parse fail — including
digits past 2^53, which would parse to a number the user did not type;
the caller surfaces `--max-size must be a size like 500M or 1G (got <value>)`.

## Tests

`tests/cli.test.ts`: `parseDuration` and `parseSize` units and parse
failures; `vx cache clean` reports 0 entries
pruned from an empty cache, and rejects an unknown subcommand.
Eviction, orphan reaping and `dry` are tested in
`tests/cache.test.ts` against `Cache.prune`; clearing in
`tests/cache-clean.test.ts`.
