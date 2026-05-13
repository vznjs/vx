# `src/orchestrator/upstream.ts` — upstream-hash filter

## Purpose

Pick which upstream task hashes participate in the current task's
cache key, per its `cache.inputs.tasks` declaration. The patterns
share `graph/dependency-spec.ts`'s parser; this module owns the
filter semantics (`*` / `^*` / negation).

## Public surface

```ts
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): string[]
```

Returns the deduped list of upstream cache hashes that pass the
filter. Order is the iteration order of the internal `Set` — the
caller of `cache.key` sorts it before folding, so order doesn't
affect identity.

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

## What this does NOT do

- **Doesn't add tasks to the graph.** That's `graph/task-graph.ts`.
  This module filters which already-completed upstream outcomes'
  hashes are folded in.
- **Doesn't validate that filter entries reference real tasks.** A
  filter for `!ghost` is silently a no-op if no upstream task named
  `ghost` exists.
