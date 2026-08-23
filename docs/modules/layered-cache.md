# `src/cache/layered-cache.ts` — local + remote cache composition

## Purpose

Wraps the local `Cache` with a **`RemoteCacheLayer`** — the plugin seam
for remote caching (`docs/design/native-cache-wire-2026-07.md`) — and
exposes the same `CacheLayer` interface. The orchestrator doesn't know
which layer it's talking to, and core ships **no wire client**: the
remote layer comes from a plugin's `cache` capability (e.g. the
`@vzn/vx-reapi` CAS client) or from an embedder
via `RunOptions.remoteCache`.

- **Read-through**: try local; on miss, fetch from remote, ingest into
  local, return with `source: 'remote'`.
- **Write-through with async upload**: write to local synchronously,
  then PUT to remote in the background (bounded at 4 concurrent;
  `run()` awaits `drainUploads()` before `cache.close()`). Remote
  errors are logged, not thrown — the task already succeeded; failed
  uploads shouldn't fail the user's run.
- **Prefetch + in-flight dedup**: `prefetch(hash)` warms local from
  remote in the background; an in-flight map shared with `get`
  guarantees **at most one remote GET per key**, and a settled miss
  blocks a second lazy probe.

## Public surface

```ts
export interface RemoteCacheLayer {
  /** Existence probe (drives the plan path's `--dry` remote prediction). */
  has(hash: string): Promise<boolean>
  /** Fetch an artifact's bytes; `null` = miss. Errors THROW. */
  get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null>
  /** Store an artifact (fire-and-forget from LayeredCache's PoV). */
  put(hash: string, body: ArrayBuffer | Uint8Array, meta: { durationMs: number }): Promise<void>
}

export class LayeredCache implements CacheLayer {
  constructor(local: Cache, remote: RemoteCacheLayer, options?: LayeredCacheOptions)
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  drainUploads(): Promise<void>
  // CacheLayer methods — see docs/modules/cache.md.
}

export interface LayeredCacheOptions {
  onRemoteError?: (err: Error) => void
  /** 4-axis policy; this layer reads remoteRead / remoteWrite. */
  policy?: CachePolicy
}
```

## The never-fail contract

`RemoteCacheLayer` implementations THROW on every failure (network,
non-404 status, integrity mismatch, oversize body). `LayeredCache`
catches **everything** and degrades to a cache miss via
`onRemoteError` — no remote failure of any kind may fail a run. A
corrupt remote body is additionally refused by `Cache.ingest`'s
validation (zstd checks), which this layer also degrades to a miss.

## Read path

1. `local.get(hash)` — return immediately on local hit. If the hash
   was materialized FROM remote earlier this run (prefetch or a
   sibling's read-through), the source flips to `'remote'` so
   provenance stays honest.
2. If `policy.remoteRead` is off → miss.
3. `pullFromRemote(hash)` — shared with `prefetch` through the
   in-flight map: `remote.get` → `local.ingest(bytes)` → re-read
   local. `durationMs` from the wire rides the ingested entry.

## Write path

1. `local.save(args)` — synchronous (honors its own local-write gate).
2. If `policy.remoteWrite`: capture the artifact bytes NOW (read the
   just-written local artifact, or pack in memory when local writes
   are disabled — `--cache=local:,remote:rw`), then queue the PUT in
   the bounded background pool. The task's worker slot is released
   immediately; `run()` drains before close.

## Delegation

`key / recordRun / stats / prune / restoreOutputs / close` are pure
delegations to the local `Cache`. The remote layer doesn't participate
in cache identity, run history, or eviction — those are workspace-
local concerns.

## What this does NOT do

- No wire knowledge — URLs, headers, integrity digests, redirects,
  timeouts all live inside the `RemoteCacheLayer` implementation
  (e.g. `@vzn/vx-reapi`'s CAS client).
- No write-batching or retry on transient errors. Fire-and-forget.

## Tests

`tests/layered-cache.test.ts` drives an in-memory stub
`RemoteCacheLayer` (counters for has/get/put) and asserts the
read-through / write-through / prefetch-dedup / degradation /
delegation contracts. `tests/orchestrator-remote.test.ts` covers the
end-to-end run paths (remote hit, plan prediction, never-fail,
at-most-once, injection precedence).

## Replacing this module

Most likely replacement: **a layered cache with a different topology**
(e.g., local → regional → global). Keep the public methods stable and
the orchestrator doesn't change. A different WIRE never touches this
module — implement `RemoteCacheLayer` in a plugin instead.
