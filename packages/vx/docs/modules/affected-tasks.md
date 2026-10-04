# `src/orchestrator/affected-tasks.ts` — the tasks `--affected` reaches

## Purpose

`--affected` selects tasks, not projects (owner, 2026-10-04). The diff
(`affectedChanges`, affected.md) seeds tasks:

- a group seeds nothing: it runs nothing;
- an uncached task seeds when its project changed;
- a cached task seeds when a changed path is one of its declared inputs
  (`declaresInput`, inputs.md), or when its project is reached whole: the
  diff named it whole, a changed path is `package.json` or a `vx.config.*`,
  or no cached task of the project declares a changed path.

A requested bare task runs when its `dependsOn` closure holds a seeded
task, so a change reaches another project only along a task edge such as
`^build`. An anchored `pkg#task` always runs. `prepareRun` drops the rest
and returns `empty: 'none-reached'` when nothing is left.

## Public surface

```ts
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[], // requested task ids, in order
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
): string[] // the ids whose closure the change reaches
```
