# `src/cache/layered-cache.ts` — local + remote cache composition

## Purpose

Wraps the local `Cache` with a **`RemoteCacheLayer`** — the plugin seam
for remote caching — and
exposes the same `CacheLayer` interface. The orchestrator doesn't know
which layer it's talking to, and core ships **no wire client**: the
remote layer comes from a plugin's `cache` capability (e.g. the
`@vzn/vx-reapi` CAS client) or from an embedder
via `RunOptions.remoteCache`.

- **Read-through**: try local; on miss, fetch from remote, stream the
  body into local, return with `source: 'remote'`.
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
  /** Where the artifacts live, named in every degrade warning; never a credential. */
  readonly endpoint?: string
  /** Existence probe (drives the plan path's `--dry` remote prediction). */
  has(hash: string): Promise<boolean>
  /** Fetch an artifact; `null` = miss. Errors THROW. `body` is read once, by core. */
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  /** Store an artifact (fire-and-forget from LayeredCache's PoV). File-backed when local holds it. */
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void>
}

export class LayeredCache implements CacheLayer {
  constructor(local: Cache, remote: RemoteCacheLayer, options?: LayeredCacheOptions)
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  drainUploads(): Promise<void>
  // CacheLayer methods — see docs/modules/cache.md.
}

export interface LayeredCacheOptions {
  /** Once per failure class; the repeats are counted at `close()`. */
  onRemoteError?: (err: Error) => void
  /** 4-axis policy; this layer reads remoteRead / remoteWrite. */
  policy?: CachePolicy
}
```

## Bodies stream, both ways

No artifact sits whole in memory on the remote path
(`docs/design/streaming-remote-2026-09.md`). `get` resolves a `Blob` or a
`Response`: an HTTP wire returns its `fetch` `Response` itself, a chunked
wire `new Response(readableStream)`, bytes in hand `new Blob([bytes])`.
`Cache.ingest` writes it to its temp with `Bun.write`, which streams a
`Response` and copies a file `Blob` without collecting either, then
validates from the temp; a body that fails mid-stream or fails validation
leaves no temp. `put` receives `Bun.file(<local artifact>)`, opened when
the plugin reads it, so a queued upload holds a path, not a buffer; a
plugin that must digest first reads `body.stream()` twice. The one
exception is `--cache=local:,remote:rw`: with no local artifact the bytes
are packed in memory during `save` and sent as `new Blob([bytes])`.

## The never-fail contract

`RemoteCacheLayer` implementations THROW on every failure (network,
non-404 status, integrity mismatch, oversize body). `LayeredCache`
catches **everything** and degrades to a cache miss via
`onRemoteError` — no remote failure of any kind may fail a run. A
corrupt remote body is additionally refused by `Cache.ingest`'s
validation (zstd checks), which this layer also degrades to a miss. A
result of the wrong SHAPE — a `get` whose `body` is not a `Blob` or a
`Response` (the pre-stream `ArrayBuffer` / `Uint8Array` included, named
as such: "body is a Uint8Array"), a `hasMany` that is not a `Set` or
`null` — is the plugin's bug, named as such through `onRemoteError`
("download <hash> failed: remote cache layer returned an invalid
result: get() resolved body is string (expected { body: Blob | Response,
durationMs } or null) — a plugin bug, degraded to a miss") and degraded
the same way, never reported as a corrupt artifact.

## What a failure says

A wire's own message names nothing: Bun's abort is "The operation timed
out.", a refused connection "Unable to connect. Is the computer able to
access the url?", a gRPC status carries its elapsed time but no server
or key. The layer knows the call and the artifact, the plugin knows the
server, so the line `onRemoteError` receives carries all three:

```
probe <hash> at <endpoint> failed: <cause>
probe of <n> artifacts at <endpoint> failed: <cause>   (hasMany)
download <hash> from <endpoint> failed: <cause>        (get, and a body ingest refused)
upload <hash> to <endpoint> failed: <cause>            (put, and the in-memory pack)
```

`<endpoint>` is the layer's optional `endpoint` field (without one the
clause is left out); a URL's `user:pass@`, query and fragment are dropped
before it is printed, since the field is a plugin's and the line is a
log. The error's `cause` is the layer's original throw.

A run's requests are concurrent, so one fact (an unreachable server)
fails every request at once. The layer says each failure CLASS once per
instance, which is once per run: the class is the error's `code` when
it carries one (a gRPC status, an errno, Bun's `ConnectionRefused`),
else its message with the artifact's hash taken out. The operation is
not part of it. The requests held back are counted, and `close()` says
`<n> more requests failed the same way: <cause>` per class that had
any, after `run()` has drained every upload and prefetch.

## Read path

1. `local.get(hash)` — return immediately on local hit. If the hash
   was materialized FROM remote earlier this run (prefetch or a
   sibling's read-through), the source flips to `'remote'` so
   provenance stays honest.
2. If `policy.remoteRead` is off → miss. `prefetch` sits behind the
   same gate: nothing is warmed from the remote either (item 641).
3. `pullFromRemote(hash)` — shared with `prefetch` through the
   in-flight map: `remote.get` → `local.ingest(body)` → re-read
   local. `durationMs` from the wire rides the ingested entry; the
   producing execution's `cpuMs` / `peakRssBytes` ride the artifact's
   own sidecar, so no wire needs to carry them.

## Write path

1. `local.save(args)` — synchronous (honors its own local-write gate).
2. If `policy.remoteWrite`: queue the PUT in the bounded background
   pool with a file-backed `Blob` over the just-written local artifact
   (or, when local writes are disabled — `--cache=local:,remote:rw` —
   bytes packed in memory NOW, while the outputs are still on disk).
   The task's worker slot is released immediately; `run()` drains
   before close.

## Delegation

`key / recordRunBundle / stats / prune / restoreOutputs / close` are pure
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
