# The shared store (2026-10-06)

**Status:** IMPLEMENTED (2026-10-06) as written, schema v32.

Owner ask (2026-10-05): "global cache in home folder like Nx in order to
share cache across workspaces".

## What changed

A workspace's cache splits in two:

- **The store** — the entries and their artifacts: `entries`,
  `entry_stdout`, `output_files`, `entry_inputs`, `store_meta` in
  `store.db`, and `<hash>.tar.zst` beside it. Content-addressed.
  Default: `~/.vx/<id>/cache` on every platform, one per
  repository, as Nx 23 keeps `~/.nx/<id>/cache` (owner, 2026-10-06:
  "do exactly like nx"; the first cut used `~/.cache/vx`, one for every
  repository).
- **The workspace index** — `<root>/.vx/cache/cache.db`: run history,
  the file-hash and blob memos, config evaluations, and what this
  checkout's disk looked like after a save or restore (`output_stamps`,
  `output_dirs`). It attaches `store.db` as `store`; SQLite resolves an
  unqualified table name in `main` first, then in `store`, so no
  statement names a schema.

A cache dir the workspace names (`cacheDir`, `--cache-dir`,
`VX_CACHE_DIR`) holds both, in one `cache.db`, as before: naming one is
how a workspace opts out of sharing.

## The repository id, as Nx 23.2

Nx 23.2 shares by default at `~/.nx/<id>/{cache,databases}`
(`utils/cache-directory.js`, `utils/git-utils.js`); `repo-id.ts` ports
its rules, without the Nx Cloud id:

- id: 16 hex of sha256(sha256(`<identity>#<workspace path in the repo>`)).
- identity: the remote, `origin`, then `upstream`, `base`, the first;
  four url shapes (scp `git@`, `https://user@`, `https://`,
  `ssh://user@host[:port]`) to `host/owner/repo`, lower case. Read from
  the common dir's `config`; an `include`, a `url "…"` rewrite or a value
  with `#`, `;`, `\` or a quote is left to `git remote -v`.
- no remote: the sorted-first root commit; a shallow clone or a
  repository with no commit has no id and shares nothing (the workspace
  holds everything, as with a named cache dir).
- the walk to `.git` stops at one not ours (owner, `HEAD`, `objects`),
  reads files with `O_NOFOLLOW`, and `~/.vx`, `~/.vx/<id>` and its
  `cache` are made 0700 one level at a time; a level open to other users
  or not ours sends the store to the workspace, said once.

Entries are content-addressed, so one store for every repository would
be as correct; the split is housekeeping (delete a repository's cache as
one directory, no lock shared with an unrelated repository's run).

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

- **The artifact is the record; the index its inventory (owner,
  2026-10-06).** Every key is seeded with `CACHE_VERSION`, bumped when
  hashing or the artifact layout changes, so an artifact one vx wrote is
  never a hit for another and the store needs no versioned directory.
  `store.db` records its own schema (`store_meta.schema`); a vx of
  another `SCHEMA_VERSION` drops its tables and keeps the artifacts.
  A lookup that finds no row but finds `<hash>.tar.zst` indexes it from
  its bytes (`Cache.adopt`: key and names checked as a remote's are) and
  hits. Two vx versions on one repository each reset the other's
  inventory; the artifacts survive both.
- **A home that cannot hold the store does not fail the run.** The
  store goes to `<cacheDir>` instead, said once per fallback.
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
