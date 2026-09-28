# `src/util/ulid.ts` — run-id generator

## Purpose

Stamp every `vx run` invocation with a sortable, collision-resistant
id (`run_id`) that's shared across every task in that invocation.
It keys the `invocations` header row (`run_id`) and every `runs` row
of that invocation, so queries group by run and id order is time
order.

## Public surface

```ts
export function ulid(): string
```

A thin wrapper over `Bun.randomUUIDv7()`: a 36-character UUIDv7 in the
standard hex-with-hyphens form (RFC 9562) — a 48-bit millisecond
timestamp leads, then a 12-bit counter (random start each
millisecond) and 62 random bits. The function
keeps its old name; the value has not been a Crockford-base32 ULID
since the hand-rolled generator gave way to Bun's built-in, which
covers the same guarantees with zero custom code.

## Properties

- **Lexicographically sortable** by time (millisecond resolution):
  later ids sort after earlier ones.
- **Collision-resistant** under parallelism — 62 random bits
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
