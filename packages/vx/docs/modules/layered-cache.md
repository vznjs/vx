# `src/cache/layered-cache.ts` — the local cache with the declared remotes behind it

## Purpose

Puts the declared **`RemoteCacheLayer`**s — the plugin seam for remote
caching — behind the local `Cache`, in declared order, and exposes the
same `CacheLayer` interface. The orchestrator doesn't know
which layer it's talking to, and core ships **no wire client**: the
remote layer comes from a plugin's `cache` capability (e.g. the
`@vzn/vx-reapi` CAS client), which `resolveCache` wraps here, or from an
embedder via `RunOptions.remoteCache`. Core builds every
`LayeredCache`; it is not on the public façade.

- **Read-through**: try local; on miss, ask each readable remote in
  declared order, stream the first hit's body into local, return with
  `source: 'remote'`.
- **Write-through with async upload**: write to local synchronously
  (packed once however many remotes), then PUT to every writable remote
  in the background (bounded at 4 concurrent per remote;
  `run()` awaits `drainUploads()` before `cache.close()`, and before the
  telemetry summary, which reports them). A stopped run (Ctrl-C,
  SIGTERM, an embedder's abort) calls `stopUploads()`: queued uploads
  never start and the drain stops waiting on the ones in flight. A read
  in flight is given up too: the lookup is not awaited, and a download's
  body errors, so its ingest removes its temp and lands nothing; the next
  run fetches it again. Each upload is tallied on the
  local `Cache` it wraps (`uploads`: count, bytes, summed ms, failed),
  so every plugin's remote reports without a seam method. Remote
  errors are logged, not thrown — the task already succeeded; failed
  uploads shouldn't fail the user's run. A remote hit this run pulled
  carries `fetchMs`, its download and ingest.
- **Prefetch + in-flight dedup**: `prefetch(hash)` warms local from
  remote in the background; an in-flight map shared with `get`
  guarantees **at most one walk of the remotes per key**, and a settled
  miss blocks a second lazy probe.
- **One remote's boundary** is its `RemoteLane` (`remote-lane.ts`): what
  the run lets it do, its shape checks, its upload pool and its
  warnings. This layer owns the order, the local store and provenance.
- **Task keys reach every remote plain.** Which branch a read may see is
  the remote's call (`turboCache()`'s `scope`, below).

## Public surface

```ts
export interface RemoteOpenContext extends PluginSecrets {
  readonly ci: boolean
  warn(message: string): void // one line naming the plugin; the remote stays on
}

/** What a remote knows of a stored artifact; `{}` when the wire says nothing. */
export interface ArtifactInfo {
  readonly size?: number // the body's bytes
  readonly durationMs?: number // the producing task's run
}

export interface RemoteCacheLayer {
  /** Where the artifacts live, named in every degrade warning; never a credential. */
  readonly endpoint?: string
  /** Optional: get ready (a credential). Once per run, before the first task, only when the policy reads or writes it. */
  open?(ctx: RemoteOpenContext): Promise<void>
  /** Optional: this run's access (an OIDC exchange's token, never a stored secret), lent to a machine that runs its tasks; asked after `open`. */
  lend?(): Promise<LentAccess | undefined>
  /** Existence probe (drives the plan path's `--dry` remote prediction); `null` = absent. */
  has(hash: string): Promise<ArtifactInfo | null>
  /** Optional batch probe: the stored subset in one round-trip; `null` = use per-hash. */
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  /** Fetch an artifact; `null` = miss. Errors THROW. `body` is read once, by core. */
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  /** Store an artifact (fire-and-forget from LayeredCache's PoV). File-backed when local holds it. `false`: nothing sent, nothing failed; no upload counted. */
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void | false>
  /** Optional: the run found `hash` in no remote and a `put` follows; a wire that checks first can skip it. */
  missing?(hash: string): void
}

export class LayeredCache implements CacheLayer {
  constructor(local: Cache, remotes: readonly ResolvedRemote[], uploadConcurrency?: number) // declared order
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  drainUploads(): Promise<void>
  stopUploads(): void
  // CacheLayer methods — see docs/modules/cache.md.
}
```

## Which branch a read sees

A task key carries no branch (VZN, 2026-10-20). Each remote gets the
run's refs (`ctx.refs`, own branch first, then its base and the default
branch) and decides. `turboCache()` names them on every read in
`x-artifact-read-scopes` (`scope: 'header'`, the default), or keys each
entry on its ref and asks every ref's key in one batch (`scope: 'key'`,
for a server that ignores the header). Where a write lands is never the
client's call: the server checks the CI OIDC token against its trust
policy. `nxCache()` and `vx-reapi` send no scope.

## Bodies stream, both ways

No artifact sits whole in memory on the remote path
(`docs/design/streaming-remote-2026-09.md`). `get` resolves a `Blob` or a
`Response`: an HTTP wire returns its `fetch` `Response` itself, a chunked
wire `new Response(readableStream)`, bytes in hand `new Blob([bytes])`.
`Cache.ingest` writes it to its temp with `Bun.write`, which streams a
`Response` and copies a file `Blob` without collecting either, then
validates from the temp; a body that fails mid-stream or fails validation
leaves no temp. A body past the artifact ceiling's zstd bound (by its
length header, its Blob size, or a running count) is refused before it
fills the disk (L-5). `put` receives a `Bun.file` over a private hard
link to the local artifact (`Cache.pinArtifact`), made when the job starts
and unlinked when it ends, so a queued upload holds a path, not a buffer,
and every read of the body sees the same bytes: a re-save of the key
renames others over the live name, and a body opened by that name read
them mid-upload. A plugin that must digest first reads `body.stream()`
twice. The one
exception is `--cache-policy=local:,remote:rw`: with no local artifact the bytes
are packed in memory during `save` and sent as `new Blob([bytes])`.

## Opening a remote

`open` is asked by `run()` alone, once, in declared order, after the
project load and before plugin `setup`, the status line and the first
task (`openRemotes`, `orchestrator/prepare.ts`), and only for a remote the
run's policy lets read or write. `--no-cache`, `--cache-policy=remote:`
and a plan (`--dry`, `vx show`) never call it, so every other method may
arrive unopened. One at a time: two remotes that ask on the terminal do
not interleave. A throw is a warning through the remote's `onError` and
clears its `read` and `write` (`ResolvedRemote`'s, which the lanes read
live), so the run goes on without it; every remote off this way is no
remote layer for the run's policy. `ctx.secret` is the supplying plugin's
keychain (`util-secrets.md`); `@vzn/vx-migrate`'s `turboCache()` and
`nxCache()` read a missing token from it here (2026-10-17).

## The never-fail contract

`RemoteCacheLayer` implementations THROW on every failure (network,
non-404 status, integrity mismatch, oversize body). `LayeredCache`
catches **everything** and degrades to a cache miss, reported to that
remote's `onError` — no remote failure of any kind may fail a run. A
corrupt remote body is additionally refused by `Cache.ingest`'s
validation (zstd checks), which this layer also degrades to a miss. A
result of the wrong SHAPE — a `get` whose `body` is not a `Blob` or a
`Response` (the pre-stream `ArrayBuffer` / `Uint8Array` included, named
as such: "body is a Uint8Array"), a `hasMany` that is not a `Map` or
`null` — is the plugin's bug, named as such through `onError`
("download <hash> failed: remote cache layer returned an invalid
result: get() resolved body is string (expected { body: Blob | Response,
durationMs } or null) — a plugin bug, degraded to a miss") and degraded
the same way, never reported as a corrupt artifact.

A probe's answer (`has`, `hasMany`, or one recorded by an earlier run)
is a hint, never the artifact: a key it says is held whose `get` returns
`null` (the server dropped it since) is a plain miss, and the task runs
(2026-10-23).

What `hasMany` said is recorded in the index's `remote_hits`
(`remote-hits.ts`), hits only, so another process trusts it
(`remoteKnown`): a pull of a kept hit starts at once, waiting on no
probe. A task's own lookup waits on no probe either: it GETs at once.
Waiting made every remote hit two round-trips, the probe then the GET
(~300 ms an up-to-date task on CI, 2026-10-24); a miss's GET answers as
fast as the probe would, so the cost is one GET for each task that asks
before the probe answers. A whole `hasMany` answer rewrites the rows it asked (new hits
in, gone ones out), and a `get` every remote answers with `null` drops
its row. A `get` that fails keeps it: the key may still be there.
A remote whose batch gives no answer is asked `has` per key when a run
needs the answer to plan (`remoteHasEach`); that whole answer is
recorded the same way, and one failed `has` is no answer.

## What a failure says

A wire's own message names nothing: Bun's abort is "The operation timed
out.", a refused connection "Unable to connect. Is the computer able to
access the url?", a gRPC status carries its elapsed time but no server
or key. The layer knows the call and the artifact, the plugin knows the
server, so the line `onError` receives carries all three:

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
fails every request at once. Each remote says each failure CLASS once
per run: the class is the error's `code` when
it carries one (a gRPC status, an errno, Bun's `ECONNREFUSED`),
else its message with the artifact's hash taken out. The operation is
not part of it. The requests held back are counted, and `close()` says
`<n> more requests failed the same way: <cause>` per class that had
any, after `run()` has drained every upload and prefetch.

## Read path

1. `local.get(hash)` — return immediately on local hit. If the hash
   was materialized FROM remote earlier this run (prefetch or a
   sibling's read-through), the source flips to `'remote'` so
   provenance stays honest.
2. If no remote may be read → miss. `prefetch` sits behind the
   same gate: nothing is warmed from a remote either (item 641).
3. `pullFromRemote(hash)` — shared with `prefetch` through the
   in-flight map: each readable remote's `get` in order, skipping one
   a batch probe found without it, until a body ingests →
   `local.ingest(body)` → re-read local. `durationMs` from the wire rides the ingested entry; the
   producing execution's `cpuMs` / `peakRssBytes` ride the artifact's
   own sidecar, so no wire needs to carry them.
4. A task waiting on its download gives it up when the rest of the
   body would take longer than running the task: twice the stored
   duration, for the save a run adds, and never under one weighing
   (25 ms: a sub-ms task is stored as 0), against the body's own pace
   so far, weighed every 25 ms. The task then runs here, a miss, and
   uploads nothing (the remote holds the key). Only a key the batch
   probe sized and timed is judged; any other is awaited. 500 tasks at
   30 ms and 4 MB/s per connection, 20 of them 8 MB: 3070 ms → 1807 ms
   (min of 5); 200 tiny tasks tie.

## Write path

1. `local.save(args)` — synchronous (honors its own local-write gate).
2. For each writable remote: queue the PUT in its bounded background
   pool with a file-backed `Blob` over the just-written local artifact
   (or, when local writes are disabled — `--cache-policy=local:,remote:rw` —
   bytes packed in memory NOW, while the outputs are still on disk).
   The task's worker slot is released immediately; `run()` drains
   before close.

## Delegation

`key / recordRunBundle / stats / prune / restoreOutputs` are pure
delegations to the local `Cache`. The remote layer doesn't participate
in cache identity, run history, or eviction — those are workspace-
local concerns.

## What this does NOT do

- No wire knowledge — URLs, headers, integrity digests, redirects,
  timeouts all live inside the `RemoteCacheLayer` implementation
  (e.g. `@vzn/vx-reapi`'s CAS client).
- No write-batching or retry on transient errors. Fire-and-forget.
- No deadline of its own. Every call is awaited: a `get` that never
  settles holds its task, and a `put` holds `drainUploads()`, which the
  run awaits before it closes, unless the run was stopped. The layer bounds its own requests: the
  first-party layers do, and the plugin guide's example shows how
  (item 856).

## Tests

`tests/layered-cache.test.ts` drives an in-memory stub
`RemoteCacheLayer` (counters for has/get/put) and asserts the
read-through / write-through / prefetch-dedup / degradation /
delegation contracts. `tests/orchestrator-remote.test.ts` covers the
end-to-end run paths (remote hit, plan prediction, never-fail,
at-most-once, injection precedence). `tests/slow-download.test.ts`
holds the judge: a body slower than its task runs the task, one faster
or unsized is awaited.

## Replacing this module

Most likely replacement: **a layered cache with a different topology**
(e.g., local → regional → global). Keep the public methods stable and
the orchestrator doesn't change. A different WIRE never touches this
module — implement `RemoteCacheLayer` in a plugin instead.
