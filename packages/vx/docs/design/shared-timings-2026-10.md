# Task timings through the remote cache (2026-10)

Status: proposed. Owner call M 2026-10-14 20:51 (via EA). Builds after DX's
local forecast PR (median of the last 5 runs, default branch first).

## Problem

`@vzn/vx-schedule-history` orders by learned durations. A fresh CI runner
or a new clone has none, so its first run orders blind. `file` (timings-file.ts)
carries them, but only through a CI cache step the user wires by hand.

## Design

The timings travel as one blob in the remote cache the workspace already
declares. No new wire, no mutable entry.

- **Key:** `xxh3('vx-timings\0' + commitSha)`. Content-addressed by the
  commit that produced it; a blob is never rewritten, so the cache stays
  immutable.
- **Write (policy allows remote writes, i.e. CI):** after the run, fetch
  the parent commit's blob (`HEAD~1`, walking back up to 5), merge this
  run's p50s over it, drop task ids the graph no longer has, put it under
  `HEAD`. A branch or PR run writes under its own sha, which no reader on
  another branch asks for: only commits that land on the default branch
  are ever read back.
- **Read (every run):** the merge-base of `HEAD` with the default branch,
  walking back up to 5 commits for a missing blob. Fetched in the
  background after scheduling; stored at `.vx/cache/timings-remote.json`
  and used from the NEXT run, so a run never waits on the network and an
  offline run is unchanged.
- **Forecast order** (M 2026-10-14 20:54), per task: this machine's
  current-branch runs (median of the last 5), then its default-branch
  runs, then the remote file, then `assume`. On CI the history is empty,
  so the remote file comes first.

## Core seam

Plugins see no remote layer today (`CacheContext` builds one, nothing reads
one). The `setup` context gains `remote`: `get(key)` / `put(key, bytes)`
over the run's declared remote layers, in chain order, bypassing the local
artifact store. Core keys the name per plugin (`xxh3(pluginName\0key)`),
applies the run's scope and policy (a `put` without remote write is a
no-op), bounds each call by the layer's own deadline, and degrades every
error to `null` with one warning. No remote declared: `remote` is
`undefined` and nothing is spawned (zero-cost gate). One seam, any plugin;
schedule-history is its first user.

## Validation (with Security)

The blob is untrusted input from a shared store:

- Size cap 1 MiB before parsing; above it, ignored with one warning.
- Shape `{ version: 1, tasks: { id: ms } }`; `ms` a finite number in
  `[0, 86_400_000]`; at most 50 000 ids; ids not in this run's graph are
  dropped; nothing from it is ever evaluated, spawned or used as a path.
- It changes only order and ETA. A poisoned file can at worst order a run
  badly; it cannot change a key, an output or what runs.

## Tests (each red first)

- CI run on commit B with blob A at its parent writes blob B = A merged
  with B's p50s, minus removed tasks.
- A local run on a branch reads the merge-base's blob in the background and
  orders by it on the next run; the first run does not wait (a remote that
  never answers leaves its wall time unchanged).
- No remote declared: no git spawn, no read (zero-cost gate).
- Oversized, malformed, out-of-range and non-graph entries are dropped,
  each named once.
- A read-only policy never puts.

## Out of scope

Sharing anything else through `remote` (run history, reservations): the
seam allows it, nothing asks for it yet.
