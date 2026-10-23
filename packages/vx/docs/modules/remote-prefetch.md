# `src/orchestrator/remote-prefetch.ts` — background remote GETs

## Purpose

With a `LayeredCache`, remote GET latency would sit on each task's
critical path. This derives every STABLE task's pure-input key up front
(reusing the run's `hashCache` memo — no double hashing) and fires the
remote GETs concurrently before scheduling, so network overlaps
execution. `LayeredCache` ingests hits into local and de-dups against
the lazy read-through: at most ONE remote GET per key.

## Public surface

```ts
export interface PrefetchArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  claimedFiles: readonly string[] // the root files the plugins claim
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  concurrency: number // the GET pump's width
  remoteRead: boolean // the policy's remote-read axis; false returns at once
  remoteWrite: boolean // with reads off: hand the keys to probeBeforeUpload
  held?: (ids: readonly string[], missed: readonly string[]) => void // once: the stable tasks a store holds, and those none does
}

export function startRemotePrefetch(args: PrefetchArgs): Promise<void>
// The CacheGetContext a lookup passes: task id, masked command, declared outputs;
// shared with execute-task's own lookup
export function getContext(node: TaskNode, command: string): CacheGetContext
```

- `startRemotePrefetch(args)` → `Promise<void>` handle. Fire-and-forget
  for scheduling; `run()` awaits it before `cache.close()` only.

## Sequence

1. `deriveStableKeys` — the pure-input keys of every stable task
   (`stable-keys.md`); none, nothing to do.
2. The keys the local store already holds (`localHasMany`) are dropped:
   a run the local cache answers makes no remote call.
3. The hits the index kept from an earlier probe (`remoteKnown`, maybe
   another process's: `vx dte plan`, then `vx run`) are trusted now:
   their pulls start at once, waiting on no probe. `held` hears them,
   and every other key as missed, only when no batch probe follows.
4. One batched existence probe when the layer offers it
   (`remoteHasMany`): the hashes it reports absent are marked
   (`markRemoteAbsent`, so the lazy read-through skips them too) and
   only the present ones are fetched. Until the probe starts
   (`probeFirst`) and while it is out, a task's own lookup waits for it,
   so a key the probe calls absent costs no GET. Its whole answer is
   kept for the next run, and `held` hears it: a key the index lacked
   was often stored since (a PR's CI stores its merged tree), and
   calling it missed sized a run for work that restored.
5. `concurrency` pumps drain the list through the layer's `prefetch`
   (the hash, the task id and its command); a rejected fetch is
   swallowed.

## Invariants

- **Remote-only**: gated on the policy's `remoteRead` axis (the run
  passes it only when a remote layer is present); local runs never
  derive keys or probe anything here. With reads off and `remoteWrite`
  on (`--force`), the keys go to the layer's `probeBeforeUpload`
  instead: one `hasMany` per remote the run only writes that can
  batch (others ask `has` per upload), so an upload of a key it holds
  is skipped.
- Stability gate via `deriveStableKeys` — unstable (codegen-consumer)
  tasks stay on the lazy path.
- Never-fail: every path degrades to a miss.
