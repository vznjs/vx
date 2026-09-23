# `src/graph/task-graph.ts` — task DAG construction + cycle detection

## Purpose

Take the set of requested `(project, task)` pairs, a workspace
package graph, and an optional `excludeDependencies` filter; produce
the concrete DAG of `TaskNode`s the scheduler will execute.

## Public surface

```ts
export interface TaskNode {
  id: string // `${projectName}#${taskName}`
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  deps: string[] // ids of tasks that must finish first; sorted
  requested: boolean // user-requested vs dep-pulled
  addsToOutputsOf?: string[] // upstream ids whose output trees this task adds to (item 588)
  outputsAddedToBy?: string[] // dependants' output globs that add into this task's tree
}

import type { ProjectEntry } from '../workspace/index.js' // { name, dir, config }

export interface BuildGraphOptions {
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  requested: Array<{ project: string; task: string }>
  excludeDependencies?: 'all' | readonly string[]
}

export function taskId(project: string, task: string): string
export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode>
// Lives in `src/util/task-id.ts` (the cache reads the same rule and may
// not import the graph); re-exported here and on the façade.
export function splitTaskId(id: string): [project: string, task: string]
export function isGroupTask(node: TaskNode): boolean
export function detectCycle(nodes: Map<string, TaskNode>): void

// Which `{project, task}` pairs a run's requested names resolve to, and
// which resolve to nothing (`vx run`'s "every requested name must resolve").
export function expandRequested(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
): Array<{ project: string; task: string }>
export function unresolvedRequests(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
): string[]

// Flags the display-only `surfaced` tasks a requested GROUP stands for;
// returns how many it flagged. See "transparent folders" in cli.md.
export function markSurfacedDeps(nodes: Map<string, TaskNode>): number

// True only when two output globs PROVABLY select an overlapping set —
// the test behind the refusal below, on the façade because
// `@vzn/vx-migrate` asks the same question at migration time and used to
// ask it with a copy that drifted (item 445).
export function outputsOverlap(a: string, b: string): boolean
```

## Construction rules

Starting from `requested`, the builder recursively expands
`dependsOn`. Each entry is parsed via
[`dependency-spec.ts`](./dependency-spec.md):

| Form          | Behavior                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'name'`      | Same-project. Missing target throws (hard error).                                                                                                                                                                                                                                      |
| `'^name'`     | Nearest-holder frontier: walk the package dep graph from direct deps; each path stops at the first package declaring the task (edge added there). Non-declaring deps are passed through (sparse bridging); nothing past a holder is walked — its own `dependsOn` owns deeper ordering. |
| `'pkg#name'`  | Specific cross-project edge. Missing pkg or task throws.                                                                                                                                                                                                                               |
| `'*'`, `'^*'` | Rejected in `dependsOn` (filter-only). UserError.                                                                                                                                                                                                                                      |
| `'!form'`     | Rejected in `dependsOn` (filter-only). UserError.                                                                                                                                                                                                                                      |

The micro-syntax parser is shared with `cache.inputs.tasks`; the
builder enforces the dependsOn-specific rejections.

**`requested: true`** marks the user-requested set. A node added via
dependsOn expansion is `requested: false`. If a node is later named
explicitly (or the user passed both `build` AND `pkg#build`), it gets
promoted to `requested: true` — never demoted.

`excludeDependencies` filters the expansion:

- `undefined` — full expansion (default).
- `'all'` — skip every dependsOn entry. Only `requested` nodes exist.
- `string[]` — drop edges whose target task name appears. Works
  uniformly across same-project, deps-bucket, and cross-project edges.

The resulting `TaskNode.deps` is the concrete id list of upstream
tasks. It's sorted before being stored so downstream cache-key
computations are deterministic regardless of how the user ordered
their `dependsOn` array.

## Cycle detection

After every reachable node has been added, `detectCycle()` runs a
3-color DFS:

- WHITE = unvisited
- GRAY = on the current DFS stack
- BLACK = fully explored

Encountering a GRAY node while traversing means we're in a cycle. The
error message formats the cycle path:

```
Cycle detected in task graph: a#build -> b#build -> a#build
```

Both cross-project cycles and self-cycles (a task listing itself) are
detected. Throws as `UserError` so the CLI prints cleanly.

## What this does NOT do

- It doesn't enforce that `cache.inputs.tasks` references resolve to
  declared upstream — that's
  [`orchestrator/upstream.ts:filterUpstreamHashes`](./upstream.md).
  Misses there are silently filtered out.
- It doesn't compute a topological order — that's the scheduler's
  job. The graph only encodes "X must finish before Y," not
  "Y runs at step N."
- It doesn't validate `excludeDependencies` against declared task
  names. Unknown names are no-ops, by design (consistent with
  Turbo's `--only` semantics).
- It doesn't fail when `requested` is empty — produces an empty map.
  The orchestrator decides whether that's a footgun.

## Tests

`tests/task-graph.test.ts` covers:

- zero-dependency single node
- `'name'` (self) expansion + missing-task error
- `'^name'` frontier expansion: nearest holder, sparse bridging,
  stop-at-holder, shared-subtree dedup
- `'pkg#name'` cross-project edge (missing throws)
- wildcard / negation rejection in dependsOn
- diamond dedup (shared upstream created once)
- cross-project cycle detection
- self-cycle detection
- empty `requested` → empty graph
- `excludeDependencies: 'all'` skips everything but requested
- `excludeDependencies: [...]` drops named edges only

`tests/output-collision.test.ts` covers the overlapping-output refusal:
what is refused, the spellings that name one path (`./dist/**` against
`dist/**`), the literal that is a whole tree (`dist` against
`dist/app.js`) with the clean that proves it, the limit where the tree
rule meets the undecided glob-vs-glob case, and the false-positive
controls — the refusal aborts the run, so a widening breaks a build that
works today.

## Replacing this module

- **Lazier graphs** — return an iterator instead of a Map, useful for
  very large workspaces. Current implementation is O(tasks × avg-deps)
  at graph build time and that's fine for any realistic monorepo.
- **Different dependency model** — e.g., conditional deps
  (`dependsOn: { task: 'build', when: 'production' }`). Would need a
  schema change on `TaskConfig.dependsOn` plus updated resolution.
  Cycle detection still terminates regardless.
- **Stable-after-add ordering** — currently `deps` is sorted. If the
  scheduler grew priority logic (longest-first), sort here.
