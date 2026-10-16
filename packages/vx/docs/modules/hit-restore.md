# `src/orchestrator/hit-restore.ts` — what a hit leaves behind

## Purpose

A confirmed cache entry, materialised: decide whether the tree is
already current (the whole-subtree directory proof, then the per-file
fingerprint proof) and skip the restore when it is; otherwise restore the
artifact in place and then remove the outputs it does not hold (pruning
only inside the declared trees, so a sibling's fresh directory stays;
inputs.md); mark the exact changed paths
against the git snapshot so a same-project consumer need not re-spawn
git; replay the stored output, both streams in order; build the cache-hit outcome. Moved out
of `execute-task.ts` on 2026-09-10 as pure code motion — the mirror of
`miss-save.ts`.

There is ONE restore path. `executeCachedTask` (a hit found in flight)
and the local short-circuit (a stable hit restored ahead of its deps)
both call `restoreHit`, so the two cannot drift.

**Stale-hit-critical.** A line changed here changes which bytes a green
run replays; treat edits like `execute-task.ts` ones.

## Public surface

```ts
export interface RestoreHitArgs {
  args: ExecuteArgs
  hash: string
  hit: CacheEntry
  /** `performance.now()` when the probe started — restore time counts from here. */
  cacheOpStart: number
  /** ns offset from run start for the outcome's wallclock window. */
  taskStartNs: bigint
}
export function restoreHit(restore: RestoreHitArgs): Promise<TaskOutcome>
```

`execute-task.ts` re-exports both, so the entry stays importable from
where it was.

## In place, never clean-then-restore

Each file is renamed over the one it replaces (archive.ts stages every
entry in the workspace's `.vx/tmp/<pid>-0/` first, never in an output
folder; a target on another filesystem goes through a temp beside it,
and a file takes the group its directory gives new files (setgid on
Linux, any directory on macOS); ACLs are not copied, a restored
file gets the default ACL of `.vx/tmp/`), so a reader of the output tree never
finds a declared output missing or half-written, and a restore that fails
before its renames (a full disk, a damaged entry) leaves the outputs it
found as they were. Only a found output that blocks a rename goes first:
a file where the entry needs a directory, or a file under a path the
entry holds as a file. The rest the entry does not hold goes once the
restore has landed. On macOS the comparison is case-folded: a rename onto
`out.txt` replaces `Out.txt`, and removing the found name would remove
the restored file. The clean used to run first: a reader polling a 64 MB
output while ten hits restored met ENOENT on 153,336 of 204,411 reads
(Growth's parity probe, 2026-10-16), and a full disk left no outputs at
all (`tests/restore-in-place.test.ts`, `tests/disk-full.unsafe.test.ts`).
Each run first removes the staging a killed run left, never a live
run's (`sweepStaging`, `tests/restore-staging.test.ts`).

## Additive tasks (item 588)

Only with `rules.exclusiveOutputs: false` (X-53); by default the graph
refuses an edge-ordered overlap. An ADDITIVE task
(`node.addsToOutputsOf`) is judged current by its
recorded rows alone and its restore rewrites exactly those rows, never
touching what its glob, which also selects the upstream's files it adds beside. An
upstream that dependants add to (`node.outputsAddedToBy`) drops the
strays their globs could have added before it judges its own tree — on
both halves, project and root-anchored (`overlapping-outputs.test.ts`
holds each, item 638) — and never a row it recorded; its restore still removes them — the dependant
restores or runs after it, by the edge.

## Since the split

- A hit on a task with no declared outputs touches no artifact: nothing
  to clean, nothing to restore, the outcome says `restored: false`.
- The directory snapshot behind the next hit's skip-restore is queued
  (`outputDirSnapshots`) and taken at run end, not inside the restore —
  a directory written microseconds ago sits in the snapshot's racy
  window — and artifact writes overlap across concurrent restores.
- The outcome carries what the producing execution used (`storedCpuMs`,
  `storedPeakRssBytes`), read from the entry the artifact's sidecar
  filled, so a fresh machine behind a remote cache has the number too.

## What it does NOT do

- Decide whether the entry is a hit: the probe (`cache.get`, or the
  up-front `preProbed` entry) happens before.
- Save anything: a hit writes no rows and no artifact. The miss path is
  `miss-save.ts`.
- Restore a `workspaceFiles` output through the directory proof: a
  root-anchored output can land anywhere, so the proof is skipped and
  the glob walk decides.

## Tests

`tests/execute-task.test.ts` (direct-drive `restoreHit` classification:
entry shapes a run cannot produce), `tests/stale-hit.test.ts` (the
proofs against a changed, deleted or rewritten output; a same-size
same-second rewrite), `tests/output-dirs.test.ts` (the directory
proof), `tests/local-shortcircuit.test.ts` (a restore-tier hit ahead of
its deps), `tests/orchestrator-run.test.ts` (restores, cleaning, stdout
replay end to end).
