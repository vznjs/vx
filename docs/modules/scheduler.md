# `scheduler.ts` — parallel topological executor

## Purpose

Walk the task graph honoring dependencies, running up to `N` tasks
concurrently, propagating failure as `skipped` to dependents while
keeping unrelated tasks moving.

## Public surface

```ts
export type TaskStatus = 'success' | 'cache-hit' | 'failed' | 'skipped'

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  hash?: string                          // cache key, when computed
}

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
}

export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>>
```

## Algorithm

A small `tick()` loop:

1. For each node still in `remaining`, check if it's ready (all
   `deps` have outcomes and none failed/skipped).
2. **Failed upstream** → mark as `skipped` immediately (synchronous,
   no `execute` call), call `onFinish`, remove from `remaining`,
   continue.
3. **Ready and no in-flight cap reached** → call `execute(node,
   upstream)`. Add to `inFlight`. Increment `active`.
4. When a task's `execute` promise resolves/rejects, record the
   outcome, decrement `active`, recurse into `tick()`.
5. When `remaining.size === 0 && active === 0`, resolve the overall
   promise.

The synchronous "skip" path is important — it can mark every remaining
task as skipped in one `tick()` invocation, without needing async
callbacks. The completion check at the end of `tick()` catches this
case and resolves the overall promise immediately.

## Failure isolation

A failed task does not stop the scheduler:

- Its direct dependents (and their dependents, recursively) get
  status `skipped`.
- Tasks not in that lineage continue to start and finish normally.
- The overall promise resolves only after every task has *some*
  outcome (success / cache-hit / failed / skipped).

This is exactly what a `--continue` flag does in other tools. We treat
it as the default because it gives users maximum information per run.

## Concurrency cap

- The scheduler never starts more than `concurrency` tasks. It will
  start fewer if the graph doesn't have that many ready tasks.
- `concurrency: 1` serializes the whole run (still respecting topo
  order).
- No work-stealing; nodes are picked in `remaining` iteration order
  (which is insertion order of the underlying `Map`).

## What this does NOT do

- Doesn't compute the graph (that's `task-graph.ts`).
- Doesn't execute tasks itself (that's `execute` callback — the
  orchestrator provides one that does cache lookup + run).
- Doesn't catch internal errors in `execute` other than treating a
  rejected promise as a failed outcome. The default behaviour writes
  the error message to stderr prefixed with `[vzn] internal error in
  <id>`.
- Doesn't enforce timeouts.
- Doesn't reorder for fairness or priority.

## Tests

`scheduler.test.ts` covers:
- Empty graph resolves immediately.
- Topological order respected (dependency completes before dependent
  starts).
- Concurrency cap honored (peak active ≤ N).
- Concurrency = 1 serializes.
- Dependents of a failed task are skipped.
- Independent siblings continue after a failure.
- Skip cascades through a chain (a → b → c, a fails → b and c skipped).
- `execute` throwing marks node failed; graph still resolves.
- Upstream outcomes passed to dependent's `execute`.

## Replacing this module

The contract is small: take a graph + an `execute`, return outcomes.
Alternatives:

- **Priority queues / heuristics** — start the longest-tail task first
  (would need duration estimates).
- **Work stealing across machines** — distribute `execute` to remote
  workers. Outcomes flow back through the same promise mechanism.
- **Adaptive concurrency** — adjust based on system load. Reasonable
  if you can measure load cheaply.

Keep `ScheduleOptions` and `TaskOutcome` shapes stable to avoid
churning consumers.
