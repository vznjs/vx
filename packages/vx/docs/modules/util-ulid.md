# `src/util/ulid.ts` — ULID generator

## Purpose

Stamp every `vx run` invocation with a sortable, collision-resistant
id (`run_id`) that's shared across every task in that invocation.
Lets analytics queries group by run without needing a separate
"runs" parent table.

## Public surface

```ts
export function ulid(now: number = Date.now()): string
```

Returns a 26-character ULID:

- 48-bit ms timestamp prefix → first 10 base32 chars
- 80 bits of `crypto.getRandomValues` entropy → next 16 base32 chars

Encoding: Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`).

## Properties

- **Lexicographically sortable** by time (millisecond resolution).
- **Collision-resistant** under parallelism — 80 bits of randomness
  is plenty for the "two `vx run` invocations within the same ms"
  case.
- **No dependencies.** Hand-rolled to keep the dep tree slim — the
  `ulid` npm package is ~12 KB with a browser/node split for features
  we don't need.

## Why not `crypto.randomUUID()`

UUIDs aren't lexicographically sortable, so grouping `runs` table
rows by time-window or "the latest run" would require a separate
timestamp column AND join. ULID does both jobs in one column.

## Tests

`tests/ulid.test.ts`:

- 26 chars total.
- First 10 chars sort with time.
- Two ULIDs taken in the same millisecond differ (entropy verified).
- Character set is Crockford base32 only.
