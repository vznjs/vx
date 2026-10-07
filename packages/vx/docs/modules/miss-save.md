# `src/orchestrator/miss-save.ts` — what a miss leaves behind

## Purpose

Once a cached task's command exited 0 and the task will save, one call
does everything a later hit depends on: resolve the declared outputs,
say so if they matched nothing, save the artifact with its output rows
and input-fingerprint rows in one transaction, record the whole-subtree
output prefixes the next hit's skip-restore reads, and mark the exact
written paths against the git snapshot so a same-project consumer
re-spawns git only when its globs can see them. Moved out of
`execute-task.ts` on 2026-09-09 as pure code motion.

**Stale-hit-critical.** A line changed here changes what a later run
replays under a green result; treat edits like `execute-task.ts` ones.

## Public surface

```ts
export interface OutputDirSnapshot {
  hash: string
  projectDir: string
  prefixes: readonly string[] // the whole-subtree output prefixes
  holds: (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean // the run-end walk's files are the entry's rows (item 1087)
}
export function entryHolds(
  node: TaskNode,
): (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean

export interface SaveMissArgs {
  node: TaskNode
  hash: string
  cache: CacheLayer
  log: Logger
  workspaceRoot: string
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache | undefined
  outputs: string[] // declared cache.outputs.files
  wsOutputs: string[] // declared cache.outputs.workspaceFiles
  ownOutputFiles?: string[] | undefined // an ADDITIVE task's own set, in place of the glob walk (item 588)
  ownWsOutputFiles?: string[] | undefined // the same for `workspaceFiles` (A-43)
  captured: readonly TaskInputComponent[] // Tier-3 rows from the pre-exec describe
  command: string
  durationMs: number
  stdout: string
  cpuMs?: number | undefined // what the execution used — stored on the entry and the artifact's sidecar
  peakRssBytes?: number | undefined
  outputDirSnapshots?: OutputDirSnapshot[] | undefined // queued for run end when present
  deferSave?: ((save: () => Promise<void>) => Promise<void>) | undefined // the run's save lane; resolves when the save lands
  measure?: boolean | undefined // a telemetry sink listens: time the save, stat its artifact
}
export interface SaveFacts {
  saveMs?: number // the save's own time (pack, write, index)
  artifactBytes?: number // the artifact it wrote
}
export function saveMiss(a: SaveMissArgs): Promise<{ landed: Promise<SaveFacts> }>

export type UnsavedArgs = Pick<
  SaveMissArgs,
  'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'gitFilesCache' | 'outputs' | 'wsOutputs'
>
export function markUnsaved(a: UnsavedArgs): Promise<void>

// save-lane.ts
export interface SaveLane {
  defer(save: () => Promise<void>): Promise<void> // resolves once the save settled, a failure too
}
export function createSaveLane(cap: number, onError: (err: unknown) => void): SaveLane
```

`markUnsaved` is step 3 alone, for a miss that ran here and saves
nothing (it failed, the policy writes nothing, an upstream failed): its
outputs are resolved and marked exactly as a save's are. Before it, a
reader after such a task kept the snapshot's index OIDs for them and
restored the bytes from before the command (item 750).

## The save lane (2026-09-10)

The execution slot is CPU-shaped (`--concurrency`) and the save is not:
pack, write, rename and one index transaction, ~2.5 ms of mostly I/O per
one-file artifact against ~5 ms of execution on the 1,000-project bench.
So when the run passes `deferSave`, only the slot-bound half runs in the
slot — resolve the outputs, warn on an empty match, mark the git
snapshot (a same-project downstream task reads both) — and the pack +
write + index + snapshot request go to `save-lane.ts`: at most
`2 × concurrency` saves in flight (each pack holds an artifact's bytes),
drained by `run()` before the upload drain (the uploads are what the
saves queued) and the snapshot loop (which reads what the saves pushed).
A save that fails is one status line and a miss next time — the task's
work ran, and a cache error degrades to a miss like a remote one. An
embedder that passes no lane gets the entry before the outcome, as
before. The one reader that must wait for the entry is admission's
in-flight join (a duplicate of the task in another run): `saveMiss`
returns the lane's `landed` promise, `execute-task` parks it in
`deferredSaves` by task id, and admission lifts its barrier on it —
the executor's own return is never held. Dependents wait on the same
promise (the scheduler's `settledOf`): their execute request carries
the upstream's output rows, which the save writes.

## Order, and why it is the order

1. `resolveOutputs` / `resolveWorkspaceOutputs` — the files as they are
   NOW, after the command.
2. The empty-set warning (`cache.outputs matched no files`) — a status
   line, once, on this miss; `outputs: []` is a deliberate cached no-op
   and says nothing. When the task declares `exec.sandbox` and no
   `allow.write`, the line names that as the cause: its writes were
   refused (item 444; until 2026-10-02 a single-package workspace's
   mask took them unnoticed, and this line was the only signal). An
   output directory linked out of the project, or a `workspaceFiles` one
   out of the workspace, is named the same way (M-61, M-65).
3. `markOutputsChanged` / `markWorkspaceOutputsChanged` /
   `invalidateWorkspacePartition` — the git snapshot learns the exact
   paths, not "everything changed"; on a 1,000-package cold run that
   is one `git ls-files` spawn per project not made. The last two mask
   each other on the workspace partition: a consumer that read it
   before the producer wrote keys from an empty set with both gone, and
   a later run whose real set is empty hits that artifact
   (`stale-hit.test.ts`, "written mid-run", item 637).
4. `cache.save` — entry, output rows and `entry_inputs` rows in one
   transaction; no exit code, because the contract accepts none and the
   caller's `exitCode === 0` gate is the invariant.
5. A snapshot request (`outputDirSnapshots`) — whole-subtree prefixes
   for the hit path's directory-mtime check, recorded at run end from
   the run's list; a caller with no list gets no snapshot (recording
   here fell inside the racy window and was always refused, item 637).

Not here: the deferred-download path (`--download=none`), which saves
no artifact and registers a closure instead (`execute-task.ts`).

## Tests

`tests/cache*.test.ts`, `tests/output-*.test.ts`, the stale-hit pins
in `tests/execute-task*.test.ts`, and the git-marking pins in
`tests/miss-save-marks.test.ts`; the split itself is covered by the whole gate
passing unchanged.
