# `src/cli/format.ts` — shared formatters

## Purpose

Small string formatters shared by multiple CLI subcommands.

## Public surface

```ts
export function formatBytes(n: number): string
```

Human-readable byte size with `B / KB / MB / GB / TB / PB` suffixes
and one decimal of precision below 10 of any unit. Powers of 1024.

| Input            | Output   |
| ---------------- | -------- |
| `0`              | `0 B`    |
| `1023`           | `1023 B` |
| `1024`           | `1.0 KB` |
| `9 * 1024 + 100` | `9.1 KB` |
| `10 * 1024`      | `10 KB`  |
| `1024 ** 2`      | `1.0 MB` |
| `5 * 1024 ** 3`  | `5.0 GB` |

## Use sites

- `vx cache prune` output (`Pruned N entries (1.3 GB freed)`).
- The future `vx stats` command (not yet implemented; the runs table
  is queryable directly via `sqlite3` today).

## Tests

`tests/cli.test.ts` includes a `formatBytes` table-driven case set.
