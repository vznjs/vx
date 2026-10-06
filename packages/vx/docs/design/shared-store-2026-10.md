# The shared store (2026-10-06)

**Status:** IMPLEMENTED (2026-10-06) as written, schema v32.

Owner ask (2026-10-05): "global cache in home folder like Nx in order to
share cache across workspaces".

## What changed

A workspace's cache splits in two:

- **The store** — the entries and their artifacts: `entries`,
  `entry_stdout`, `output_files`, `entry_inputs`, `store_meta` in
  `store.db`, and `<hash>.tar.zst` beside it. Content-addressed, so any
  workspace of the user may read it. Default:
  `~/.vx/cache/store-v32` on every platform (owner, 2026-10-06; the
  first cut used `~/.cache/vx` / `~/Library/Caches/vx`).
- **The workspace index** — `<root>/.vx/cache/cache.db`: run history,
  the file-hash and blob memos, config evaluations, and what this
  checkout's disk looked like after a save or restore (`output_stamps`,
  `output_dirs`). It attaches `store.db` as `store`; SQLite resolves an
  unqualified table name in `main` first, then in `store`, so no
  statement names a schema.

A cache dir the workspace names (`cacheDir`, `--cache-dir`,
`VX_CACHE_DIR`) holds both, in one `cache.db`, as before: naming one is
how a workspace opts out of sharing.

Nx 23.2 shares by default too, per repository: `~/.nx/<id>/cache`, the
id 16 hex of a sha256 of the git remote and the workspace's path in it
(`utils/cache-directory.js`). vx keeps one store for every repository:
a file is named by its key, so two repositories share one only when
they produced the same thing, and a per-repository split would buy
housekeeping for a git read per run.

## Why split, not move

Moving the whole `cache.db` to the home directory would share what is
one workspace's alone:

- `vx last`, `vx why`, `vx-schedule-history` and the MCP tools read
  `runs` and `invocations`: one shared table answers with another
  repository's runs (about 25 statements would each need a workspace
  filter).
- `output_files` carried the inode and ctime THIS checkout saw after a
  restore. Two worktrees of one repo share every key, so each
  overwrote the other's stamps and every switch between them restored
  (the row "two worktrees on one entry each stay up to date" fails with
  `output_stamps` moved into the store).
- Plugin files keyed by name alone (`vx-migrate`'s mapping, the Nx graph
  snapshot) would be read across repositories.

The keys were already workspace-relative (`relFor`), and the run lock is
keyed by the workspace, not the cache dir, so the entries share as is.

## Decisions

- **Versioned store directory.** An older vx refuses an index of a newer
  schema; with one store per machine, upgrading one repository's vx
  would fail every other's runs. `store-<SCHEMA_VERSION>` keeps them
  apart; an old store is left for the user to delete.
- **A home that cannot hold the store does not fail the run.** The
  store goes to `<cacheDir>/store-v32` instead, said once per fallback.
- **An index that held its entries itself loses them** when it next
  opens with a store (they would shadow the store's): its history
  stays, its entries miss once, `vx cache prune` reaps their artifacts.
- **Stamps and directory snapshots carry no foreign key**: the entry may
  be another database's. `prune` and a re-save delete what they orphan;
  a lookup starts at the entry, so a leftover is never read.
- **One salt per store.** `entry_inputs` digests are compared with
  another workspace's run, so the salt moved from `schema_meta` to
  `store_meta`.
- **Trust.** Every workspace of the user writes the store, as two
  workspaces on one `--cache-dir` always could. A sandboxed task cannot
  write it unless a grant names it; an unsandboxed one can write
  anywhere, as before.

## Measured

Warm `vx run build --all`, 500 generated packages, 15 interleaved
rounds, min / median: main 195 / 214 ms, shared store 183 / 202 ms,
named cache dir 188 / 213 ms. The attached store costs nothing
measurable.
