# `src/orchestrator/graph-memo.ts` — the task graph, read back whole

## Purpose

Building 1,206 tasks' graph was 4.5 ms of a warm run (2026-10-23), nearly
all of it code a short process runs cold. The graph memo stores the graph
a run built in `fold_memo` and reads it back when nothing it is built from
moved: half the cost. Its token also names every node's config and edges
for the run key memo (`run-keys.md`), which then serializes no config.

## Public surface

```ts
export interface GraphMemo {
  folds: FoldMemo
  lock: string // lockDigest of the lock the configs were read from (lockfile.md)
  metas: readonly ProjectMeta[]
}
export function memoGraph(
  options: Parameters<typeof buildTaskGraph>[0],
  memo: GraphMemo | undefined,
): { nodes: Map<string, TaskNode>; token: string | undefined }
```

- `memoGraph` — `buildTaskGraph`, answered from the memo on a token
  match. The token is the code (`codeIdentity`), the lock's bytes, the
  root, the rules, whether edges have a source, the requested tasks, each
  discovered project's name, directory, config path and direct deps, and
  the loaded project names. The row holds each node's project, task,
  `requested`, deps and addition marks; a row naming a task no loaded
  config declares reads as absent. `token` is undefined, and the graph is
  built as before, with no memo or a scoped load (`undeclaredDeps`).

`prepareRun` passes a memo only when every config is the lock's: a fold
memo, no staged configs, a lock read, and no `project` plugin. It sets
`hashCache.graph` to the token, and clears it once a `graph` or `key`
plugin or `--exclude-dependencies` edits the nodes.

Tests: `tests/graph-memo.test.ts` (a read-back graph is the built one,
addition marks included; a hit reads no config; another lock, edge or
project builds afresh; a scoped load is not remembered).
