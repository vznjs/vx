# `src/cache/scoped-cache.ts` — which remote key a scoped run asks

## Purpose

A scoped run (`VX_CACHE_SCOPE=vznjs/vx:feat-x`, a plugin's or the branch's) asks each remote one key per task (owner,
2026-10-17): a task the branch changed reads the scope's key; every other
task reads the default key. The local store never knows a scope (owner,
2026-10-17): every branch shares one local pool under the task keys.
`prepare.ts` builds a `BranchScope` when the run names one, hands it to
`LayeredCache`, which asks each remote through `remote()`, and routes the
tasks (`routeTasks`) from what the branch changed
(`RunOptions.scopeChanges`).

## Public surface

```ts
export function scopedKey(scope: string, hash: string): string
export class BranchScope {
  constructor(scope: string)
  routeTasks(ids: ReadonlySet<string>): void
  noteKey(taskId: string, hash: string): void
  remote(inner: RemoteCacheLayer): RemoteCacheLayer
}
```

## Rules

- **The scope's key** is `xxh3("vx-cache-scope", scope, task key)`, 16
  hex like a task key, so every wire stores it unchanged. An artifact is
  packed under its task key wherever it is stored, so a remote entry
  ingests locally under that key; ingest refuses an artifact packed
  under another, so a collision is a miss.
- **Routes.** `computeTaskHash` tells the cache each task's key
  (`noteKey`, through `LayeredCache`). A task `routeTasks` named is the
  scope's: its own declared inputs match a changed path, or its
  `dependsOn` closure holds such a task (`keyedByChange`, strict: a
  changed path no task declares reaches none, so a README edit leaves
  `build` on the default key). Before `routeTasks` is called every task
  is the scope's; a run always routes (`branchChanges`, or an embedder's
  `scopeChanges`).
- **Reads** (`has`, `hasMany`, `get`) ask one key: the scope's for a
  scope task, the default key for any other. No fallthrough: a miss is a
  miss.
- **Writes** (`put`) go to the scope's key, every task's: a CI run saves
  every task it builds under the scope, so a branch never writes a
  default key. Whether a run writes at all is the policy's call.
- **One disk, one pool**: a hit fetched under a scope is kept locally
  under the task key, so the same inputs hit locally on any branch.
