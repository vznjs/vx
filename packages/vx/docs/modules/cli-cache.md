# `src/cli/cache.ts` — `vx cache prune`

## Purpose

Implements `vx cache prune`. Both parsers are `util/size.ts`'s,
re-exported here: the workspace's `cacheRetention` field reads the
same spellings the flags do. Drives
`Cache.prune({...})` from `src/cache/cache.ts` against the cache
directory a run would use.

## Public surface

```ts
export async function cacheCmd(args: readonly string[]): Promise<number>

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  dryRun?: boolean
  cacheDir?: string // `--cache-dir`: prune the cache a run with the same flag uses
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs
export { parseDuration, parseSize } from '../util/index.js'
```

## Subcommand surface

```
vx cache prune --older-than <duration>
vx cache prune --max-size <size>
vx cache prune --older-than 7d --max-size 500M   # both
vx cache prune --max-size 1G --dry-run           # say what the policy would reap; delete nothing
vx cache prune --older-than 30d --cache-dir <path>
```

At least one of `--older-than` / `--max-size` is required, and neither
may be zero — a policy that would evict every entry is refused with
"delete the cache directory instead". A bare number for `--max-size`
is refused too: `--max-size 10` would read as ten bytes and evict
nearly everything; give a unit. Both policies may be combined:
age-based eviction first, then LRU eviction if the total is still
over the size cap. The prune also reaps orphaned artifacts (an archive
with no index row) and stale temps, and says so — `Pruned 12 entries
(1.4 GB freed), reaped 3 orphaned artifacts (…)`; a dry run prints
`Would prune …` and `would reap`.

The directory is the one a run would use — `--cache-dir`,
`defineWorkspace({ cacheDir })` and a `config` plugin's edit of it,
through `cliCacheDir` — or a prune silently no-ops against the wrong
path. A cache this user cannot write is refused up front with the
directory named, as a run refuses it (a dry run only reads, and reads
a read-only cache fine), and an upgrade that reset the index is
announced once.

## Parsers

### `parseDuration(input): number | null`

```
/^(\d+)([smhd])$/i
```

Returns ms. `s` (× 1000), `m` (× 60_000), `h` (× 3_600_000), `d`
(× 86_400_000), case-insensitively (`30D` is thirty days). `null` on
parse fail; the caller surfaces `invalid duration: <value>`.

### `parseSize(input): number | null`

```
/^(\d+)([KMGT])?B?$/i
```

Returns bytes. Multipliers are powers of 1024 (`K`, `M`, `G`, `T`).
Optional trailing `B` is allowed. `null` on parse fail — including
digits past 2^53, which would parse to a number the user did not type;
the caller surfaces `invalid size: <value>`.

## Tests

`tests/cli.test.ts`: `parseDuration` and `parseSize` units and parse
failures; `vx cache prune` with no policy errors, reports 0 entries
pruned from an empty cache, and rejects an unknown subcommand.
Eviction, orphan reaping and `dryRun` are tested in
`tests/cache.test.ts` against `Cache.prune`.
