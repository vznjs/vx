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
  (`declaresInput`, inputs.md), or when its project is reached whole: the
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
run after.

## Public surface

```ts
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[], // requested task ids, in order
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph, // the `^name` walk, for the packages it passes through
): string[] // the ids whose closure the change reaches
```
