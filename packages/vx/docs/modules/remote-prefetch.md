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
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  concurrency: number // the GET pump's width
  remoteRead: boolean // the policy's remote-read axis; false returns at once
}

export function startRemotePrefetch(args: PrefetchArgs): Promise<void>
```

- `startRemotePrefetch(args)` → `Promise<void>` handle. Fire-and-forget
  for scheduling; `run()` awaits it before `cache.close()` only.

## Sequence

1. `deriveStableKeys` — the pure-input keys of every stable task
   (`stable-keys.md`); none, nothing to do.
2. One batched existence probe when the layer offers it
   (`remoteHasMany`): the hashes it reports absent are marked
   (`markRemoteAbsent`, so the lazy read-through skips them too) and
   only the present ones are fetched.
3. `concurrency` pumps drain the list through the layer's `prefetch`
   (the hash, the task id and its command); a rejected fetch is
   swallowed.

## Invariants

- **Remote-only**: gated on the policy's `remoteRead` axis (the run
  passes it only when a remote layer is present); local runs never
  derive keys or probe anything here.
- Stability gate via `deriveStableKeys` — unstable (codegen-consumer)
  tasks stay on the lazy path.
- Never-fail: every path degrades to a miss.
