# `src/cli/cache.ts` — `vx cache prune`

## Purpose

Implements `vx cache prune` plus the shared duration / size parsers
exported for tests. Drives `Cache.prune({...})` from
`src/cache/cache.ts` with a workspace-resolved cache directory.

## Public surface

```ts
export async function cacheCmd(args: readonly string[]): Promise<number>

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs
export function parseDuration(input: string): number | null
export function parseSize(input: string): number | null
```

## Subcommand surface

```
vx cache prune --older-than <duration>
vx cache prune --max-size <size>
vx cache prune --older-than 7d --max-size 500M   # both
```

At least one of `--older-than` / `--max-size` is required. Both may
be combined: age-based eviction first, then LRU eviction if the total
is still over the size cap.

## Parsers

### `parseDuration(input): number | null`

```
/^(\d+)([smhd])$/
```

Returns ms. `s` (× 1000), `m` (× 60_000), `h` (× 3_600_000), `d`
(× 86_400_000). `null` on parse fail (caller surfaces
`invalid duration`).

### `parseSize(input): number | null`

```
/^(\d+)([KMGT])?B?$/i
```

Returns bytes. Multipliers are powers of 1024 (`K`, `M`, `G`, `T`).
Optional trailing `B` is allowed. `null` on parse fail.

## What this does NOT do

- **Doesn't honor `vx.workspace.ts` `cacheDir`.** Hard-codes
  `<workspaceRoot>/.vx/cache`. A follow-up should route through
  `workspace/workspace.ts:resolveCacheDir` to match `vx run`.
- **Doesn't list candidates.** `--dry-run` semantics aren't wired up;
  `Cache.prune` does the eviction directly.

## Tests

`tests/cli.test.ts` covers:

- `parseDuration` units + parse failures.
- `parseSize` units + parse failures.
- `parsePruneArgs` requires at least one policy.
- `vx cache prune --older-than 0s` no-ops cleanly.

Real eviction logic is tested in `tests/cache.test.ts` against
`Cache.prune`.
