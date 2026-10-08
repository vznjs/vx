# `src/orchestrator/affected-tasks.ts` — the tasks `--affected` reaches

## Purpose

`--affected` selects tasks, not projects (owner, 2026-10-04). The diff
(`affectedChanges`, affected.md) seeds tasks:

- a group seeds nothing (it runs nothing), but for the default `build`;
- an uncached task seeds when a changed path lies in its project
  (`changes.paths`) or the project is reached whole, never only because
  another task of it declares a changed root file (`workspaceFiles`
  owners join `changes.projects` alone);
- a cached task seeds when a changed path is one of its declared inputs
  (`declaresInput`, inputs.md), or its `workspaceFiles` may reach into a
  changed nested repository (`changes.nested`, `workspaceFilesReachInto`), or when its project is reached whole: the
  diff named it whole, a changed path is `package.json` or a `vx.config.*`,
  or no cached task of the project declares a changed path.

A requested bare task runs when its `dependsOn` closure holds a seeded
task, so a change reaches another project only along a task edge such as
`^build`. The default `build` (projects.ts) is the one keyed group: it
seeds as a cached task with `**` as input. A `^name` edge the graph
passes through a package it loaded no config for reaches it the same way:
any change there reaches the task. An anchored `pkg#task` always runs. `prepareRun` drops the rest
and returns `empty: 'none-affected'` when nothing is left. The closure
walk keeps its own stack, so a chain as deep as the builder takes
(50,000) is walked, where a recursion per edge threw `RangeError`.

A cached task's `workspaceFiles` is asked of every node, not only of the
changed projects' (whose owners the selection found from the staged
configs), so an input a `graph` hook gave it counts.

With a `graph` plugin the selection follows the FINAL graph: `prepareRun`
runs the hooks first, over every candidate (the CLI widens the
candidates to every project), asks `affectedRoots` of the edited nodes,
and prunes the graph to the `dependsOn` closure of the kept requests
plus what a hook added or marked requested; a request only a kept task
pulls in is demoted, as a rebuild from the kept requests would leave it.
Without one the graph is rebuilt from the kept requests and the hooks
run after. The hooks are `applyGraphStage` (`graph-stage.ts`), the run's
`graph` stage with its per-plugin config check.

`keptByAffected` is the rule both callers apply: a request survives when
the user named it, another include selected its project outright (X-10),
or `affectedRoots` reaches it. `affectedTaskProjects` is `vx show <task>
--affected`'s question asked the run's way: the candidates' graph, the
`graph` stage when a plugin has one, then `keptByAffected`, with no cache
opened and no key derived, so the list is the projects the run keeps
(X-147).

## Public surface

```ts
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[], // requested task ids, in order
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph, // the `^name` walk, for the packages it passes through
): string[] // the ids whose closure the change reaches

export function keptByAffected<R extends { project: string; task: string }>(
  nodes: ReadonlyMap<string, TaskNode>,
  requested: readonly R[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  keep?: { named?: ReadonlySet<string>; outright?: ReadonlySet<string> },
): R[] // the requests `--affected` keeps, in order

export async function affectedTaskProjects(args: {
  task: string
  candidates: readonly string[] // the projects the filters selected
  changes: AffectedChanges
  outright?: readonly string[] | undefined
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  projectMetas: readonly ProjectMeta[]
  plugins: readonly VxPlugin[]
  workspaceRoot: string
  cacheDir: string
  rules?: WorkspaceRules | undefined
  warn: (message: string) => void
}): Promise<string[]> // the projects whose `task` the run keeps
```
