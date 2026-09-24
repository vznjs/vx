# `src/orchestrator/admission.ts` — dedup and taint between scheduler and task

## Purpose

The scheduler hands `run()` a ready task; `executeTask` runs it. Two
rules stand between them and neither changes what the task is:

- **In-flight dedup.** An embedder running concurrent delegated runs
  in one process (a daemon built on the façade; core ships none)
  supplies an `inflight` registry (`RunOptions.inflight`). A cacheable
  task whose key a sibling is already computing waits for the sibling,
  then cache-hits on what it saved. A stateless `vx run` passes no
  registry and takes the untouched path: no key derivation before
  execute.
- **Continue-taint.** Under `continueMode: 'always'` a task runs
  although an upstream failed. Its key is the healthy one (pure-input
  hashing) but its bytes are not, so its save is withheld
  (`taintedUpstream`) and the taint propagates through every success
  built on it — otherwise a grand-dependent would cache the same
  partial tree one hop later. Only that mode executes a task behind a
  failure; a default run carries no check. `--exclude-dependencies`
  seeds the same taint (`seeds`): a task whose key folds a dependency
  that did not run (`excluded-keys.md`) has bytes nothing vouches for,
  and so does everything built on it. No seed and no `always` keeps
  the check off.

Split from `run.ts` on 2026-09-10 (pure motion).

## Public surface

```ts
export function taintTracker(
  continueAlways: boolean,
  seeds: ReadonlySet<string>,
): (node: TaskNode, upstream: TaskOutcome[]) => boolean

export interface AdmissionArgs {
  inflight: Map<string, Promise<void>> | undefined
  policy: CachePolicy
  shortCircuit: ShortCircuit
  hashArgs: Omit<ComputeHashArgs, 'node' | 'upstream' | 'nestedProjectDirs'> & {
    nestedDirsByProject: ReadonlyMap<string, string[]>
  }
  buildExecuteArgs: (node, upstream, reuseProbe?: boolean) => ExecuteArgs
}
export function admitTasks(
  args: AdmissionArgs,
): (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
```

`admitTasks` returns the scheduler's `execute` callback. Dedup applies
only when it can help: a non-group, non-persistent task with a `cache`
block, under a policy where the sibling will WRITE and this task can
READ (`localRead || remoteRead` and `localWrite || remoteWrite`). A
restore-tier task (a confirmed local hit the scheduler runs ahead of its
deps) is never deduped: it restores rather than executes, and its live
`upstream` is incomplete, so a key recompute would be wrong. A task
that joins a sibling drops its up-front probe (`reuseProbe: false`) —
the probe predates the sibling's save and would report a stable miss.
A task whose probed hit vanished before its restore rejects with
`RestoreDemoted` (execute-task.md); admission deletes its `preProbed`
entry on the way to the scheduler, so the second dispatch probes afresh
instead of restoring the same gone artifact again. It stays in the
restore-tier set, so that dispatch still skips dedup.

The executor registers its barrier with no `await` between `get` and
`set`, so at most one executor exists per hash. The barrier is lifted in
a `finally` on every exit — but not before the save has landed: a miss's
save runs off the execution slot (the save lane, `miss-save.md`), and a
joiner released before the entry existed would probe a miss and run the
task again, so the `finally` reads the lane's landing promise
(`ExecuteArgs.deferredSaves`, keyed by task id) and lifts on it; with
no lane, at once.

## What it does NOT do

- Decide WHERE a task runs (`placement.ts`) or whether it is a hit
  (`execute-task.ts`, `local-shortcircuit.ts`).
- Withhold the save itself: the tracker only answers; `execute-task`'s
  miss path reads `taintedUpstream` (see `miss-save.md`).

## Tests

`tests/inflight.test.ts` (two runs sharing a registry execute a key
once; the joiner hits; the barrier is released on failure),
`tests/continue-taint.test.ts` (the tainted task runs and does not
save; taint reaches the grand-dependent; other modes skip),
`tests/taint-tracker.test.ts` (each poisoning status, and a seed with
no failure upstream).
