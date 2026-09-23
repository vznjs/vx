# A streaming remote cache seam (2026-09-23, roadmap 2.2)

**Status:** IMPLEMENTED (2026-09-23) as written. Proof 1 measured with
`packages/vx-bench/stream-remote-bench.ts` on a 150 MiB artifact over a
disk-backed stub: peak RSS +495 MiB over the round trip before, +45 MiB
after. The signed Turbo download writes its temp first and signs it from
the file (the tag's length prefix precedes the body, and a chunked
response declares no length), and the REAPI streamed read keeps the
digest check `readBlob` already made.

The remote cache seam is the last place a whole artifact must sit in
memory. `RemoteCacheLayer.get` resolves `{ body: ArrayBuffer }` and
`put` takes `ArrayBuffer | Uint8Array`. A 150 MiB artifact therefore
costs 150 MiB of resident memory on every upload and every download,
times the upload pool. This page fixes the new contract before any code
changes, because the change breaks the plugin API and must land before
the 1.0 freeze (`roadmap-1.0.md` § 2.2).

## The contract

```ts
interface RemoteCacheLayer {
  has(hash: string): Promise<boolean>
  hasMany?(hashes: readonly string[]): Promise<Set<string> | null>
  /** `body` is read once, by core, straight into the local cache. */
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  /** `body` is file-backed when the local store holds the artifact. */
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void>
}
```

- **`get` returns `Blob | Response`.** An HTTP plugin returns the
  `fetch` `Response` itself, so the body streams from the socket to disk
  and is never collected. A plugin whose wire is chunked (REAPI's
  ByteStream) returns `new Response(readableStream)`. A plugin holding
  bytes returns `new Blob([bytes])`. Core never calls `.arrayBuffer()`
  on it.
- **`put` takes a `Blob`.** Core passes `Bun.file(<local artifact>)`, so
  a plugin that hands the Blob to `fetch` uploads it as a stream, and one
  that needs a digest first reads `body.stream()` twice. The one mode
  with no local artifact (`--cache=local:,remote:rw`) packs in memory as
  today and passes `new Blob([bytes])`. That mode keeps its memory
  profile by necessity, as the save path already documents.
- **No bytes union.** The old `ArrayBuffer | Uint8Array` shapes are not
  accepted beside the new ones. Pre-alpha, one release train, and every
  first-party layer changes in the same commit. A layer that resolves
  bytes is refused at the boundary like any other wrong shape
  (`invalidRemoteResult`), and the message names the new shape.

## Core

- **Download.** `LayeredCache.doPullFromRemote` checks the shape (`Blob`
  or `Response`, else the existing invalid-result miss), then hands the
  body to `Cache.ingest`. `ingest` writes it to its temp path with
  `Bun.write(tempPath, body)`, which streams a `Response` and a file
  `Blob` without collecting them. It then calls `writeArtifactAndIndex(hash,
{ tmpPath }, meta)`, which already validates from the file (the
  decompression-bomb and archive checks run on the temp before the final
  path is touched). A failed write or validation unlinks the temp and
  degrades to a miss, as today.
- **Upload.** `LayeredCache.save` enqueues `put(hash,
Bun.file(outputsPath(hash)), meta)`. The file is opened by the job, so
  the "bytes read inside the job" rule (item 642) now costs nothing: a
  queued job holds a path, not a buffer. A concurrent prune that removed
  the file makes the plugin's read throw, and the job's catch reports it,
  as today.
- **`ingest(hash, Uint8Array)` goes.** Its only caller is the pull path.
  Tests that seed through it pass a `Blob`.

## First-party layers

- **`turboCache()`** (`vx-migrate/src/turbo-cache`). Without a signing
  key, `get` returns the `Response` after the status checks, and `put`
  sends the Blob as the fetch body. With a key, the tag (`x-artifact-tag`,
  an HMAC over the body) must pass before core sees a byte, or a bad
  artifact would reach the cache. So `get` streams the body into a temp
  file in the OS temp directory while feeding the HMAC, refuses a bad tag
  (deleting the temp), and otherwise returns a `Response` over the temp
  file's stream that unlinks the temp when the stream ends or is
  cancelled. `put` computes the HMAC with one pass over `body.stream()`
  before the request.
- **`nxCache()`** (`vx-migrate/src/nx-cache`). `get` returns the
  `Response`; `put` sends the Blob.
- **`@vzn/vx-reapi`** (`src/cache.ts`). `put`: one pass over
  `body.stream()` through a sha256 hasher for the digest, then
  `findMissingBlobs`, then `writeBlob` from a second pass. `writeBlob`
  gains a stream overload that sends ByteStream chunks of the existing
  `CHUNK_BYTES` from the Blob's stream; a blob under the batch limit may
  still be read whole. `get`: `readBlob` gains a streaming variant that
  yields ByteStream chunks; the layer returns `new Response(stream)`.
  CAS digests are verified by the server on write; a read is verified by
  core's archive validation, as today.

## What does not change

The cache key, the artifact bytes, `CACHE_VERSION` and the local store's
on-disk layout. The upload pool's concurrency. The degrade-to-miss rule
for every remote failure.

## Proof

1. **Memory.** A 150 MiB artifact round trip (save with upload, wipe the
   local copy, pull) through the stub layer in `vx-bench`, before and
   after, peak RSS read back from the process (`vx last` or
   `process.resourceUsage().maxRSS`). Expected: the before arm's peak
   grows by at least the artifact size, and the after arm's by a small
   constant.
2. **Rows.** A layer resolving `{ body: Uint8Array }` is refused as
   invalid (the old shape). A `Response` and a `Blob` both ingest. A
   truncated `Response` body degrades to a miss and leaves no temp. The
   upload job passes a file-backed Blob (`body.name` is the artifact
   path). REAPI: a blob larger than one chunk round-trips through the
   stream path against the in-process fake server, and one under the
   batch limit still round-trips. Turbo: a signed artifact with a bad tag
   is refused and leaves no temp.
3. **Docs.** The plugin guide, `remote-caching.md`, the module page for
   `layered-cache.ts`, and the snapshot of the facade's types.
