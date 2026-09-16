# `src/orchestrator/hit-restore.ts` — what a hit leaves behind

## Purpose

A confirmed cache entry, materialised: decide whether the tree is
already current (the whole-subtree directory proof, then the per-file
fingerprint proof) and skip the restore when it is; otherwise clean the
declared outputs and restore the artifact; mark the exact changed paths
against the git snapshot so a same-project consumer need not re-spawn
git; replay the stored stdout; build the cache-hit outcome. Moved out
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
