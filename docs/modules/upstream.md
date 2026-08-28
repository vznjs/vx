# `src/orchestrator/upstream.ts` — upstream selection

## Purpose

Answer two related questions about a task's dependencies, which are
NOT the same question:

1. **Which upstream hashes the cache key folds** — per the task's
   `cache.inputs.tasks` declaration. The patterns share
   `graph/dependency-spec.ts`'s parser; this module owns the filter
   semantics (`*` / `^*` / negation).
2. **Which real tasks are in the input closure** — what an
   input-shipping executor must place in the input root. That is the
   `dependsOn` closure with GROUP tasks expanded into what they stand
   for, and it is deliberately NOT filtered by `cache.inputs.tasks`.

## Public surface

```ts
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): Array<[upstreamTaskId: string, hash: string]>

export function expandGroupUpstream(upstream: readonly TaskOutcome[]): TaskOutcome[]
```

`filterUpstreamHashes` returns the hash-deduped list of upstream
entries that pass the filter, each paired with the id of the first
task seen at that hash (for `entry_inputs` row naming — the id is
never folded). Order is the iteration order of the internal `Map` —
the caller of `cache.key` sorts before folding, so order doesn't
affect identity.

## Groups are transparent to the input closure

A group task has no `exec`, so it produces nothing and has no cache
entry: its hash is a synthetic roll-up (`computeGroupHash`). That is
correct for the KEY — a dependent cascades through the roll-up, and
anything changing beneath the group moves it. It is wrong for the
INPUT CLOSURE, where asking the local index what the group produced
returns an empty list.

Locally that is invisible: the members' outputs are already on disk,
put there by their own tasks. Remotely it is fatal — that list IS the
input root, so `dependsOn: ['install']` shipped a worker an action
containing none of what `install` chains.

`expandGroupUpstream` walks a group's `TaskOutcome.groupUpstream`
(set by the group's own execution, the only place that knows what it
chained), recursing for nested groups and de-duplicating by task id.
The expansion is never folded: it reaches the executor as
`CacheKeyInput.upstreamGraft` → `TaskInputs.upstream`, while the key
still folds only the group's roll-up hash, so no existing entry moves.

## The key filter does not filter the input closure

`cache.inputs.tasks` is an INVALIDATION statement — the schema defines
it as "which upstream tasks' cache keys participate in this task's
key". What a task may READ is `dependsOn`, and locally every
dependency's outputs are on disk before the command runs however the
filter is written.

So the closure is built from the unfiltered dependency set. Deriving
it from the filtered one instead would mean a task decoupled from an
upstream's key silently loses that upstream's BYTES when it runs
remotely, while behaving correctly on the machine that submitted it —
the same conflation as the group case, arrived at from the other side.
`tests/execute-task.test.ts` pins both directions: an upstream
excluded from the key is still in the closure, and a CONTROL that the
filter still decouples the key.

## Defaults

- **`filter === undefined`** → every upstream contributes
  (`[...].filter(u => u.hash).map(...)`). Most common.
- **`filter === []`** → empty result; fully decoupled task.

## Pattern semantics

| Form         | Matches                                        |
| ------------ | ---------------------------------------------- |
| `'*'`        | every same-project upstream                    |
| `'^*'`       | every dep-workspace upstream                   |
| `'name'`     | same-project task `name`                       |
| `'^name'`    | `name` task in any dep workspace               |
| `'pkg#name'` | specific package's `name` task                 |
| `'!<form>'`  | exclude — applies to whatever the form matches |

**Last write wins.** Patterns are applied in order; a later include
re-adds a previously excluded hash; a later exclude removes a
previously included one. So `['*', '^*', '!^noisy']` reads
"all upstream, then drop deps' `noisy` task hashes".

## Error surface

Invalid spec strings (caught by the shared `parseDependencySpec`)
throw `UserError` prefixed with the task id and `cache.inputs.tasks:`.
The CLI prints this cleanly.

## Tests

`tests/orchestrator.test.ts` covers the cache-key delta cases for
`*` / `^*` / specific / `pkg#task` / `!form` / `[]` / undefined.
The pattern parser itself is tested in
`tests/task-graph.test.ts` (shared module).
`tests/execute-task.test.ts` pins group expansion end to end — a
dependent of a group receives the tasks beneath it WITH their output
lists, and a CONTROL asserts the dependent's cache key does not move
when the group carries members.

## What this does NOT do

- **Doesn't add tasks to the graph.** That's `graph/task-graph.ts`.
  This module filters which already-completed upstream outcomes'
  hashes are folded in.
- **Doesn't validate that filter entries reference real tasks.** A
  filter for `!ghost` is silently a no-op if no upstream task named
  `ghost` exists.
