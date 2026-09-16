# `src/util/ulid.ts` — run-id generator

## Purpose

Stamp every `vx run` invocation with a sortable, collision-resistant
id (`run_id`) that's shared across every task in that invocation.
Lets analytics queries group by run without needing a separate
"runs" parent table, and range-scan a time window on the id column
with no index on the time column.

## Public surface

```ts
export function ulid(): string
```

A thin wrapper over `Bun.randomUUIDv7()`: a 36-character UUIDv7 in the
standard hex-with-hyphens form (RFC 9562) — a 48-bit millisecond
timestamp leads, 74 bits of randomness fill the rest. The function
keeps its old name; the value has not been a Crockford-base32 ULID
since the hand-rolled generator gave way to Bun's built-in, which
covers the same guarantees with zero custom code.

## Properties

- **Lexicographically sortable** by time (millisecond resolution):
  later ids sort after earlier ones.
- **Collision-resistant** under parallelism — 74 bits of randomness
  is plenty for the "two `vx run` invocations within the same ms"
  case.
- **No dependencies, no custom code.**

## Why not `crypto.randomUUID()`

A v4 UUID isn't lexicographically sortable, so grouping `runs` table
rows by time-window or "the latest run" would require a separate
timestamp column AND join. A v7 UUID does both jobs in one column.

## Tests

`tests/ulid.test.ts`:

- 36 characters, the UUIDv7 shape.
- Many rapid generations are all unique.
- Later ids sort after earlier ones.
