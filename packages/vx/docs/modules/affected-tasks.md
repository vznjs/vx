# `src/orchestrator/affected-tasks.ts` — the tasks `--affected` reaches

## Purpose

`--affected` selects tasks, not projects (owner, 2026-10-04). The diff
(`affectedChanges`, affected.md) seeds tasks:

- a group seeds nothing (it runs nothing), but for the default `build`;
- an uncached task seeds when its project changed;
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
and returns `empty: 'none-affected'` when nothing is left.

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
