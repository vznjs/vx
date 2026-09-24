# `src/orchestrator/keyed-projects.ts` — the projects a key answers for

## Purpose

K(T) in `docs/design/linked-sibling-reads-2026-09.md`: for a task, the
directories of every project whose files its cache key already moves
with. A sandboxed task that declares `cache` is granted a linked
workspace package through `node_modules` only when that package is in
this set (`sandbox-request.ts`); every other link inside the workspace
root is withheld, since an edit there would not re-run the task.

## Public surface

```ts
export function keyedProjects(
  nodes: ReadonlyMap<string, TaskNode>,
): (node: TaskNode) => ReadonlySet<string>
```

`run.ts` builds one lookup per run and hands it to every task
(`ExecuteArgs.keyedProjects`); execute-task asks it only on the miss path
of a sandboxed task that declares `cache`.

## Rules

- **The fold relation is the hash path's, on the graph.** An exec task
  folds its dependencies as its own `cache.inputs.tasks` selects them
  (absent, or no `cache`, means all), through `upstream.ts`'s
  `selectFoldedDeps` — the one copy of the matcher. A group folds every
  dependency. The walk is transitive.
- **Every exec task reached counts its project, cached or not.** A key
  folds the task's own project files, and a task with no `cache`
  declares no `inputs.files`, so it folds every file of its project (the
  design assumed it folded none; the key-level rows refuted it). A group
  counts nothing of its own.
- **A persistent task is folded by no one.** Neither key path gives it a
  hash (the local classify pass, `stable-keys.ts`, skips it as the live
  path does, item 727), so nothing beneath it reaches the key.
- **The task itself is not counted**, and its own project is never
  granted through a link anyway (`sandbox-request.ts`).
- **Lazy and memoized by task id.** A run of hits asks nothing; a shared
  subgraph is walked once. The walk is a post-order on an explicit
  stack, since a fold is as deep as the graph (the builder takes
  50,000, item 737) and a recursion per edge overflowed the call stack.

## Cost

A warm run of hits never calls it. Measured 2026-09-24 on `vx-bench`'s
1,000-package workspace (`bun packages/vx-bench/generate.ts <dir> 1000`:
3,000 nodes, 2,000 exec tasks), over the graph `prepareRun` builds,
min / median of 30, 4-core Xeon container:

| Shape                                            | Every exec task, fresh lookup | Worst task, fresh    |
| ------------------------------------------------ | ----------------------------- | -------------------- |
| the generator's (`build` a leaf)                 | 0.28 / 0.50 ms                | 0.001 ms (1 project) |
| deep (`build` → `^build`: closures span a third) | 18.4 / 28.0 ms                | 3.6 / 4.2 ms (334)   |

The first column is the bound for a run where every task is sandboxed,
cached and executes; the memo makes it the whole graph's walk, once.
`sandboxRequestFor` then realpaths the keyed directories: for the deep
worst task (334 of them, three real links) 1.36 / 1.69 ms against 0.25 /
0.36 ms uncached — beside a sandboxed spawn, which costs hundreds.

This repo's gate (`vx run ci --all`), interleaved against a worktree of
the previous commit, each arm in its own copy: cold (cache wiped), min of
3, 159 s before and 142 s after, every run green (the spread, 142–251 s,
is the suites' own); warm, min / median of 15, 0.49 / 0.59 s before and
0.51 / 0.62 s after. The warm stage table is equal through `classify +
probe` (60 / 61 ms), `task hash` and `stable keys`; what differs lies in
`run graph`, which on a warm gate is `check.bun`, the one uncached
sandboxed task, and whose median favoured the after arm (462 ms, against 477).

## Tests

`tests/keyed-projects.test.ts`: the walk row by row on hand-built graphs
(R3, a 50,000-deep chain among them), and against the key itself (R4) — for each shape `run()` computes
the task's real hash, every other project is edited in turn, and the
hash must move for exactly the projects the set names on the live path,
and for at least them on the classify path.
