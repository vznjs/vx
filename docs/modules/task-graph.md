# `task-graph.ts` — task DAG construction + cycle detection

## Purpose

Take the set of requested `(project, task)` pairs and a workspace
package graph; produce the concrete DAG of `TaskNode`s the scheduler
will execute.

## Public surface

```ts
export interface TaskNode {
  id: string                       // `${projectName}#${taskName}`
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  deps: string[]                   // ids of tasks that must finish first; sorted
}

export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

export interface BuildGraphOptions {
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  requested: Array<{ project: string; task: string }>
}

export function taskId(project: string, task: string): string
export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode>
```

## Construction rules

Starting from `requested`, recursively expand `dependsOn`:

- **`dependsOn.self`** — each name MUST resolve to a declared task in
  the same project. Missing target throws:
  > `Task <id> depends on <project>#<missingTask> but no such task is declared`
- **`dependsOn.dependencies`** — for each transitive workspace dep
  (from `packageGraph.transitiveDeps`), look up the named task. If the
  dep declares it, add a node. If it doesn't, silently skip (it's
  normal for tasks to be sparse across packages).

The resulting `TaskNode.deps` is the concrete id list of upstream
tasks for THIS task. It's sorted before being stored, so cache key
computations downstream are deterministic regardless of how the user
ordered fields in their config.

## Cycle detection

After all reachable nodes are added, `detectCycle()` runs a 3-color
DFS over the graph. White → Gray → Black coloring; encountering a Gray
node while traversing means we're in a cycle. The error message
formats the cycle path:

```
Cycle detected in task graph: a#build -> b#build -> a#build
```

Both cross-project cycles and self-cycles (a task listing itself in
`dependsOn.self`) are detected.

## What this does NOT do

- It doesn't enforce that the user's `cache.inputs.tasks` filter
  references valid task names. Filter mismatches are silently ignored
  in `orchestrator.filterUpstreamHashes`.
- It doesn't sort by execution order — that's the scheduler's job. The
  graph only encodes "X must complete before Y," not "Y runs at step N."
- It doesn't fail if `requested` is empty — produces an empty map.

## Tests

`task-graph.test.ts` covers:
- zero-dependency single node
- `dependsOn.self` expansion + missing-task error
- `dependsOn.dependencies` expansion across transitive deps
- both buckets combined
- silent skip for cross-project missing tasks
- diamond dedup (shared upstream created once)
- cross-project cycle detection
- self-cycle detection
- empty `requested` returns empty graph
- literal name targeting in dependencies (filtered against transitive set)

## Replacing this module

The graph shape (`Map<string, TaskNode>` with sorted `deps`) is what
the scheduler consumes. Alternatives:

- **Lazier graphs** — return an iterator instead of a Map, useful for
  very large workspaces. The current implementation is O(tasks ×
  avg-deps) at graph build time and that's fine for any realistic
  monorepo.
- **Different dependency models** — e.g., support specific workspace
  dep targeting (`dependsOn: { in: ['lib-a'], task: 'build' }`).
  Would need a new `TaskDependsOn` shape plus updated resolution
  logic. Make sure cycle detection and graph build still terminate.
