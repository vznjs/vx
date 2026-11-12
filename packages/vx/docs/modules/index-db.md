# `src/index-db/` — cache.db's one schema

The tables every module that reads or writes cache.db shares, below
`cache`, `memo` and `history`, and the SQLite helpers they all use. It
imports only `util`.

## `src/index-db/schema.ts` — every table, once

### Purpose

`createTables`: every table's DDL, the one place each is declared, with what each row means. The store opens the file and checks
`SCHEMA_VERSION`; each statement against a table lives with the module
that owns its rows.

### Public surface

```ts
// The index's schema. A mismatch drops and recreates the index: no
// migrations, so any change to what it stores bumps this.
export const SCHEMA_VERSION = 'v56'
// Every table; `store` names the schema holding the entry tables ('main'
// when one cache.db holds everything, 'store' for the attached shared store).
export function createTables(db: Database, store?: 'main' | 'store'): void
export function createArtifactTables(db: Database, store: 'main' | 'store'): void
// What every reader and `vx last --sql` means by `runs`, as a TEMP view.
export const RUNS_VIEW: string
// The two WHERE fragments every history query shares, so "a run that
// executed" and "a run with a key" mean one thing across metrics.ts,
// history.ts and failure-mode.ts.
export const EXECUTED_RUNS_SQL = "status <> 'skipped'"
export const KEYED_RUNS_SQL = "hash <> ''"
// `hash IN (…)` for a batch: one `json_each` array, or `= ?` for one hash.
export function inHashes(hashes: readonly string[]): { test: string; params: string[] }
// The 30-day retention of run history, memo and remote-hit rows.
export function pruneHistoryRows(db: Database, cutoff: number): number
// A statement prepared on its first run or get.
export function lazyStatement(db: Database, sql: string): ReturnType<Database['prepare']>
export function closeDb(db: Database): void
// A page SQLite cannot read, and an index on a full disk (SQLITE_FULL).
export function unreadableIndex(err: unknown): boolean
export function isIndexFull(err: unknown): boolean
export const SQLITE_FCNTL_PERSIST_WAL = 10
```

### Tests

`tests/caching-doc-drift.test.ts` holds caching.md's table list to the DDL;
and `tests/info-corrupt-index.test.ts`.
