# `src/orchestrator/excluded-keys.ts` — keying a dependency that does not run

## Purpose

`--exclude-dependencies` changes what RUNS, never what a key is. The
dependant's key folds its dependencies' keys (`caching.md` step 10),
and before 2026-09-24 dropping the edge dropped the fold with it: the
dependant keyed on nothing of the dependency, so it missed for no
reason, and once the dependency changed it hit an entry built against
the old one (nx#35234, reproduced on vx: `app#build` replayed `L1`
while `lib/dist` held `L2`).

`excludeDependencies` (graph) takes the edges out of the schedule and
returns the dropped tasks with their `deps` intact. This module derives
each one's key without running it and sets it on the dependant as
`TaskNode.excludedUpstream`, which `keyUpstream` (`upstream.md`) folds
next to the live outcomes at every key site.

## Public surface

```ts
export interface KeyExcludedArgs {
  nodes: Map<string, TaskNode> // the scheduled graph
  keyOnly: ReadonlyMap<string, TaskNode>
  dropped: ReadonlyMap<string, readonly string[]>
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: ReadonlyMap<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}
export async function keyExcludedDependencies(args: KeyExcludedArgs): Promise<void>

export function excludedTaint(nodes: ReadonlyMap<string, TaskNode>): {
  seeds: ReadonlySet<string> // tasks whose key folds a dropped dependency's key
  unsaved: number // cacheable tasks the taint reaches, for the run's one line
}
```

`keyExcludedDependencies` runs in `prepareRun`, after the `graph` and
`key` stages have seen the whole graph (so a dropped task carries the
same plugin key material a full run gives it). Keys are derived over
the whole graph as it stands at the start of the run, once per task: a
dropped task's own dependencies, scheduled or not, fold theirs, and a
scheduled task that is itself a dropped dependency folds what IT lost.
A persistent task has no key, as on the live path; a group rolls its
members up (`computeGroupHash`).

The walk is a post-order on an explicit stack: each task's key promise
is made after its dependencies' promises exist, so nothing recurses
once per edge, and the keys still resolve concurrently. A dropped chain
is as deep as the graph, and the graph builder takes 50,000 (item 737);
keying one by recursion overflowed the call stack. `excludedTaint`
walks the dependant edges once from its seeds for the same reason: a
fixpoint that re-scanned every node per hop was quadratic on a chain
seeded at its bottom (100 s at 50,000).

## Why the dependant does not save

Folding the key makes the dependant's entry claim "built against that
dependency at its current inputs". The dependency did not run, so its
outputs on disk may predate those inputs, and a save would file stale
bytes under the key the next full run derives — a stale hit that run
would replay. `excludedTaint` names the tasks whose key folds a
dropped key (a group folds all of its dependencies; an exec task what
its `cache.inputs.tasks` selects), `run()` seeds the taint tracker with
them (`admission.md`), and the save is withheld for them and everything
built on them. A read is still correct: an entry under the full key was
built by a run whose dependency matched it. A task with
`cache.inputs.tasks: []` folds none and saves as usual. `run()` says
once how many cacheable tasks the taint reaches; a persistent task or
one with no `cache` saves nothing anyway and makes no line.

## Tests

`tests/stale-hit.test.ts` › "--exclude-dependencies keys on the
dependency it skips": the dependant's key is the same with and without
the flag, and it hits; a change to the dependency is a miss; a lazily
keyed dependant (one waiting on a same-project producer) folds it too;
a requested dependency that lost an edge itself is keyed on what it
lost; a dependency two hops below the dropped one reaches the key
through it (its key must exist before the dropped one's is derived);
and what a run builds on an out-of-date dropped dependency, or on a
group that dropped one, is not saved. `tests/local-shortcircuit.test.ts`
› "restore-tier dependent reports cache-hit even when its dep FAILS" is
the `tasks: []` control: excluded, it still saves.
`tests/prepare-run.test.ts` keys a 50,000-deep dropped chain and holds
the typo refusal under the flag; `tests/taint-tracker.test.ts` ›
"excludedTaint" counts a 50,000-deep chain seeded at its bottom.

## What this does NOT do

- Verify a dropped dependency's outputs against its key. Proving a tree
  current is `hit-restore.ts`'s job on a hit; here the conservative
  answer (no save) costs one re-run on the next full run.
- Widen the sandbox's keyed set (`keyed-projects.md`), which walks the
  scheduled `deps`: a key that folds more than that set names is safe.
- Hide the dropped dependency from an executor. `excludedUpstream`
  reaches the executor with the live upstream, so an input-shipping
  executor's `TaskInputs.upstream` lists it with the key a full run
  derives and whatever outputs the local index records under that key.
  The no-save rule is core's (`taintedUpstream` withholds core's save);
  an executor that keeps its own record of executions under the cache
  key is not told, the same as for `--continue=always`'s taint.
- Hide the dropped tasks from plugins. The `graph` and `key` stages see
  the whole graph, as a full run shows it; only the `schedule` stage
  and later see the narrowed one.
