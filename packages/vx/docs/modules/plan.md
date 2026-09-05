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
}

export interface RunPlan {
  tasks: PlannedTask[]
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  cachePolicy?: CachePolicy // a no-read policy predicts misses
  forwardArgs?: readonly string[]
  nestedDirsByProject: Map<string, string[]>
}

export function plan(args: PlanArgs): Promise<RunPlan>
```

## Algorithm

Piggybacks on `runGraph` with `concurrency: 1` and a planning
`execute` closure:

1. For each node in topo order, compute the same cache key the real
   run would (`computeTaskHash` for normal tasks, `computeGroupHash`
   for groups).
2. Probe `cache.get(hash)`:
   - `cache.get` returns a hit object → `'hit-local'` (or
     `'hit-remote'` when `hit.source === 'remote'`).
   - Returns `null` → `'miss'`.
3. Group tasks short-circuit to `'group'`.
4. Tasks with no `cache` block OR `--no-cache` set → `'no-cache'`.
5. Return a `RunPlan` with one `PlannedTask` per node, preserving the
   `TaskNode.deps` graph for downstream rendering.

## Side effects

`cache.get(hash)` bumps the SQLite `accessed_at` column for every hit
(that's the contract). Otherwise the planner is read-only — no spawn,
no `cleanOutputs`, no `restoreOutputs`.

## Why concurrency: 1

Planning is fast (no spawn, just a hash + DB lookup) and sequential
is easier to reason about. Topological ordering is what the
underlying `runGraph` provides; we keep it. Parallel planning could
shave milliseconds; not worth the complexity.

## Tests

`tests/plan-format.test.ts` covers the formatters consuming
`RunPlan`; `tests/orchestrator.test.ts` covers `planRun` end-to-end
(workspace discovery + graph + planner). Specific cases:

- `--no-cache` flips every task to `'no-cache'`.
- Local cache hit predicted correctly after a real run.
- Remote hit prediction (LayeredCache + remote stub).
- Group task status.
- Empty plan when no projects declare the task.

## Replacing this module

This is a thin wrapper around `computeTaskHash` + `cache.get`. If you
need a richer plan (e.g. include estimated duration from `runs`
history), extend `PlannedTask` and update the formatters.
