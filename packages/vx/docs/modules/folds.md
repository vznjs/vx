# `src/graph/folds.ts` — which dependencies a key folds

## Purpose

The fold relation on the graph alone, before any hash exists: which of a
task's dependencies its cache key folds, per its `inputs.tasks`. The
hash path (`orchestrator/upstream.ts`), the sandbox's keyed set
(`keyed-projects.ts`), the stable-key gate and `vx lock`'s input-overlap
rule (`task-graph.ts`) all read this one selection, so they cannot drift.

## Public surface

```ts
// A group runs nothing: no `exec`.
export function isGroupTask(node: TaskNode): boolean
// `node.deps` less `node.orderOnly`: the dependencies a key may fold.
export function keyedDeps(node: TaskNode): readonly string[]

export interface FoldCandidate {
  node: TaskNode
  unit: string // what the fold dedups by: the hash, or a stand-in equal exactly when the hashes are
}
// `inputs.tasks` applied in order, last write wins; undefined selects all, [] none.
// An edge in `standIns` (the task's `standInsOf`) is selected with any edge it went past.
export function selectFoldedDeps(
  deps: readonly FoldCandidate[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
  standIns?: StandIns,
): FoldCandidate[]
// The dependencies one task's key folds, as `keyUpstream` hands them to
// the key: scheduled edges less order-only ones, plus `excludedUpstream`.
export function foldedDeps(node: TaskNode, nodeOf: (id: string) => TaskNode): FoldCandidate[]
// An `inputs.tasks` spec that matches a member only through a group is refused,
// and an exact one that names no dependency.
export function refuseFiltersThroughGroups(nodes: ReadonlyMap<string, TaskNode>): void
```

## Rules

- **A filter selects among the task's own dependencies, never through a
  group.** `build.*` over a group `build` misses the members the key
  does not fold otherwise, so it is refused rather than decoupling the
  key, also when it matches another dependency directly.
- **An exact filter names a dependency.** The load pairs a `pkg#task`
  entry or dependency with any form whose task half matches, unable to
  tell this project's name from another's, so `['nope#build']` over
  `dependsOn: ['build']` (or `['build']` over `['b#build']`) selected
  nothing and replayed a stale hit. Once the graph is built (`vx lock`,
  `--check` and a run's plan) it is refused unless a `^` entry or a pattern names its task, either of
  which may match nothing in a preset's project.
- **A group folds every dependency**; an exec task what its
  `inputs.tasks` selects (absent means all).
- **Folded transitively counts.** `vx lock` lets a task read a
  producer's outputs only when the producer is in its `dependsOn`
  closure and in none of the folded closure this relation walks.
