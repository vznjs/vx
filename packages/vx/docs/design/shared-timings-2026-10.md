# Task timings through the remote cache (2026-10)

**Status:** built (EA go 2026-10-15). Owner call M 2026-10-14 20:51 (via EA).
Built as designed, except: no `VX_DEBUG` output (core has no such
setting; every refusal is silent), and only CI on `defaultBranch` writes
(M 22:19).

## Problem

`@vzn/vx-schedule-history` orders by learned durations. A fresh CI runner
or a new clone has none, so its first run orders blind. `file` (timings-file.ts)
carries them, but only through a CI cache step the user wires by hand.

## Design

The timings travel as one blob in the cache the workspace already
declares. No new wire, no mutable entry.

- **Key:** `xxh3('vx-timings\0' + commitSha)`. Content-addressed by the
  commit that produced it; a blob is never rewritten, so the cache stays
  immutable. Each run also writes it under that commit and its graph's
  task ids (2026-10-22): every CI job of a commit writes its own graph's
  tasks and the first job's plain blob wins, so a reader asks its own
  graph's blob first, then the plain one.
- **Write (on CI, core's `ci` fact; the policy decides which layers keep
  it):** after the run, fetch the newest blob along `HEAD`'s lineage (a
  job before it on `HEAD`, else the parent's, walking back up to 5) and
  merge this run's p50s over it, keeping every task it holds: a job cannot
  tell a task the repo dropped from one only another job runs
  (2026-10-22). So whichever of a commit's blobs a reader gets holds every
  task, and a job whose task set changed still finds its own. Put it under
  `HEAD`; a merge over 1 MiB keeps only the run's own tasks. A branch or PR run writes under its own sha, which no reader on
  another branch asks for: only commits that land on the default branch
  are ever read back.
- **Read (only when needed):** only when some task in the run has no
  current-branch history does the plugin compute the merge-base of `HEAD`
  with the default branch. A downloaded blob is applied as rows in the
  shared store's duration table (`~/.vx/<repo-id>`, the one DX's forecast
  reads), tagged by that merge-base sha; no timings file is kept on disk
  (M 21:01). It is fetched only when no row carries that sha, walking back
  up to 5 commits for a missing blob, so each repo downloads it once for
  all its worktrees. So most runs
  make no network call and no extra git spawn. A fetch never holds the
  run (M 2026-10-16, replacing 20:55's "wait for download"): the run
  orders from local history at once, and the fetched timings re-rank the
  tasks not yet started through `ctx.refine` when they land, within a
  500 ms deadline; on timeout or error they are dropped, silently. A
  merge-base with no blob is asked once.
- **Forecast order** (M 2026-10-14 20:54), per task: this machine's
  current-branch runs (median of the last 5), then the remote file, then
  its runs on any branch (median of the last 5), then `assume`. On CI the
  history is empty, so the remote file comes first.

## Core seam

The plugin seam exposes the cache, never the remote (M 21:06). The `setup`
context gains `cache`: `get(key)` / `put(key, bytes)` backed by the same
layered cache tasks use: the local store first, then each declared remote
in order, under the run's write policy and scope. Core keys the name per
plugin (`xxh3(pluginName\0key)`), bounds each call by the layers' own
deadlines, and degrades every error to `null` (a remote's thrown fault is
said once since 2026-10-23, M: never swallow a remote error; an absent
entry stays silent). The plugin never learns whether a remote exists: with none, `get`
is a local lookup. `cache.hasMany(keys)`, namespaced the same way, asks
the layers' existing batch probes and resolves `null` when no layer has
one; the plugin then falls back to sequential `get`. So the walk back
over up to 5 merge-base ancestors is one `hasMany` and one `get`, inside
the 500 ms deadline. `cache.has(key)` (M 21:11) is the layers' `has`, a
HEAD that is cheaper than `get` for a large blob, with the same silent
`null` on error.
One seam, any plugin; schedule-history is its first user.

## Concurrency

Before any `cache.get`, the plugin looks up rows tagged with the
merge-base sha; if any exist it skips the cache entirely. Imported rows
carry a unique key on `(sha, task)` and are written with `INSERT OR
IGNORE`, so a repeat import is a no-op. Rows are append-only and written in the run's existing IMMEDIATE
transaction with the busy timeout. A test runs several worktrees in
parallel on one store: no lost rows, no `SQLITE_BUSY` failure, no lock
wait on the warm path.

## Validation (with Security)

The blob is untrusted input from a shared store:

- Size cap 1 MiB before parsing; above it, ignored.
- A missing or refused forecast is not the user's problem: no warning
  ever, only `VX_DEBUG` output (M: no extra runtime warnings).
- Shape `{ version: 3, tasks: { id: ms }, needs?: { id: { cpu, rss?,
cores?, memory? } } }`; `ms` a finite number in `[0, 86_400_000]`; at
  most 50 000 ids; ids not in this run's graph are dropped; nothing from
  it is ever evaluated, spawned or used as a path.
- `needs` (2026-10-21) is each task's measured need: `cpu` its most cores
  busy, `rss` its peak memory in bytes, `cores` / `memory` the machine it
  filled. Core keeps it on the imported row (schema v45), and a task
  never run on this machine takes it (`resourcesFor`), so `@vzn/vx-dte`
  packs a fresh CI machine's agents by what the default branch measured.
  A value out of range is dropped.
- `defs` (2026-10-23) is each task's definition (`taskDefinitions`: its
  command and `env.define`). A reader keeps only a timing whose
  definition is the task's now (schema v48), so a task whose command
  changed under its name starts over; one with no `defs` entry is read
  by no such reader. A string over 64 characters is dropped.
- It changes only order, ETA and packing. A poisoned file can at worst
  order or pack a run badly; it cannot change a key, an output or what
  runs.

## Tests (each red first)

- CI run on commit B with blob A at its parent writes blob B = A merged
  with B's p50s, every task of A kept.
- Two jobs whose task sets overlap each read their own tasks back; a job
  whose task set changed still reads every task.
- A local run on a branch with no history orders by the merge-base's blob
  in the same run; a remote that never answers costs at most the deadline,
  and the run orders without it.
- Every task has current-branch history: no git spawn, no fetch.
- `cache.has` answers true after a `put` and false for an absent key,
  through the local store and a remote layer.
- Two runs on the same merge-base sha: one `cache.get`, no duplicate rows.
- Oversized, malformed, out-of-range and non-graph entries are dropped,
  silently (`VX_DEBUG` names each).
- A read-only policy keeps a `put` out of the remote; a local run never puts.

## Out of scope

Sharing anything else through `cache` (run history, reservations): the
seam allows it, nothing asks for it yet.
