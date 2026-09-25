# `src/orchestrator/plan.ts` — `--dry` / `--graph` planning

## Purpose

Walk the task graph, compute every task's cache key, and probe the
cache to predict what `vx run` would do — _without executing_. Drives
the `--dry`, `--dry=json`, and `--graph` output formats.

## Public surface

```ts
export type CacheStatus =
  | 'hit-local' // entry exists locally
  | 'hit-remote' // remote layer has it (would be fetched)
  | 'miss' // caching enabled but no entry
  | 'no-cache' // task opts out (no `cache` block) or --no-cache
  | 'group' // no `exec`; aggregator only

export interface PlannedTask {
  node: TaskNode
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number // typical duration from history, on a task that would run
  executor?: string // the executor's name, when the workspace declared a choice
  download?: 'deferred' // outputs would stay remote (`--download`)
}

export interface PlanPrediction {
  wallMs: number // critical path over the would-run tasks' p50s
  workMs: number // their sum
  unknownCount: number // would-run tasks with no history
}

export interface RunPlan {
  tasks: PlannedTask[]
  predicted?: PlanPrediction // present when history gave something to say
  unresolvedTasks?: readonly string[] // requested specs that matched no project — an abandoned plan
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  cachePolicy?: CachePolicy // a no-read policy predicts misses
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache // the run's memo — the same keys the run would derive
  history?: HistoryProvider // p50s and the prediction; absent, no footer
  executorOf?: (id: string) => string | undefined // placement labels (`placement.md`)
}

export async function plan(args: PlanArgs): Promise<RunPlan>
```

## Algorithm

Piggybacks on `runGraph` with `concurrency: 1` and a planning
`execute` closure:

1. For each node in topo order, compute the same cache key the real
   run would (`computeTaskHash` for normal tasks, `computeGroupHash`
   for groups), through the run's `hashCache` memo.
2. Probe `cache.has(hash)` — a presence check, never a fetch:
   `'local'` → `'hit-local'`, `'remote'` → `'hit-remote'`, nothing →
   `'miss'`. Prediction keys off READS: a no-read policy (`--no-cache`,
   `--force`) predicts `'no-cache'` without probing.
3. Group tasks short-circuit to `'group'`. A persistent task gets no
   key and `'no-cache'`, as on the live path (its outcome carries no
   hash, so a dependant folds nothing for it): keying it made `--dry`
   call its dependants misses under a key the run never looks up
   (item 766, `tests/stale-hit.test.ts` › "`--dry` calls a dependant of
   a persistent task by the key the run uses").
4. Tasks with no `cache` block OR `--no-cache` set → `'no-cache'`.
5. With a `history`, attach each would-run task's p50 and predict the
   run (`predicted`: the critical path's wall time, the work sum, the
   tasks without history); a broken history read fails open — the
   plan stands without the footer.
6. Attach the executor label (`executorOf`) and the download mode
   (`downloadOf`) each task would get, and the gate's downgrades.
7. Return a `RunPlan` with one `PlannedTask` per node, preserving the
   `TaskNode.deps` graph for downstream rendering.

## Side effects

None: `cache.has` bumps nothing (the `accessed_at` column moves on a
fetch, which a plan never makes), no spawn, no `cleanOutputs`, no
`restoreOutputs`.

## Why concurrency: 1

Planning is fast (no spawn, just a hash + DB lookup) and sequential
is easier to reason about. Topological ordering is what the
underlying `runGraph` provides; we keep it. Parallel planning could
shave milliseconds; not worth the complexity.

## Tests

`tests/plan-format.test.ts` covers the formatters consuming
`RunPlan`; `tests/plan-predict.test.ts` the p50s, the prediction and
that predicted keys are the executed keys; `tests/orchestrator.test.ts`
covers `planRun` end-to-end (workspace discovery + graph + planner).
Specific cases:

- `--no-cache` flips every task to `'no-cache'`.
- Local cache hit predicted correctly after a real run.
- Remote hit prediction (LayeredCache + remote stub).
- Group task status.
- Empty plan when no projects declare the task.

## Replacing this module

This is a thin wrapper around `computeTaskHash` + `cache.has`, plus
the history, placement and download decorations. A richer plan
extends `PlannedTask` and the formatters (`plan-format.md`) together;
the JSON form enumerates its fields, so a new one is not on the wire
until it is added there.
