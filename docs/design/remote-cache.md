# Remote cache — protocol design

> **Status: proposal.** Nothing here is implemented. This doc records the
> design we've settled on so the eventual implementation has a target.

## What we're solving

The local cache (`docs/caching.md`) makes one machine's repeat runs fast.
A remote cache lets a team or CI fleet share entries: a task computed on
one machine becomes a cache hit for everyone else with the same inputs.

Concretely, every `vzn run` invocation:

1. Computes N task cache keys (one per task in the resolved graph).
2. For each key, decides if it can replay or must execute.
3. After execution, persists the entry so future runs (here or
   elsewhere) can hit it.

Remote cache replaces the local filesystem under steps 2-3 with a
network-backed key/value store.

## Access pattern (what the wire actually sees)

- **Read-heavy.** A typical CI run has 80-95% cache hits. The hot path is
  HEAD/GET, not PUT.
- **Many small lookups.** A monorepo with 200 tasks issues 200 existence
  checks at the start of a run, mostly in parallel.
- **Few large transfers.** A `build` output for one package can be tens
  of MB (tens of thousands of small files in `dist/`); a `test` output
  might be 0 bytes (caching the no-op success).
- **Bursty.** Concurrency is set by `os.cpus().length` by default —
  dozens of parallel uploads/downloads, then idle.
- **Per-machine sequential within a task.** No two processes on the same
  machine race for the same hash (the local orchestrator schedules
  sequentially), but multiple machines can race for the same hash —
  last-writer-wins is fine because entries are content-addressed.

## Protocol options

| Protocol          | Multiplexed                              | CDN-friendly | S3-compat backend | Notes                                                      |
| ----------------- | ---------------------------------------- | ------------ | ----------------- | ---------------------------------------------------------- |
| HTTP/1.1 + REST   | no (HOL blocking on a single connection) | yes          | yes               | Many parallel connections needed; works everywhere.        |
| **HTTP/2 + REST** | yes (single conn, many streams)          | yes          | yes               | Same REST surface, far better concurrent behavior.         |
| HTTP/3 (QUIC)     | yes                                      | yes          | rare              | Better on flaky networks; less ubiquitous server support.  |
| WebSocket         | yes (one channel)                        | no           | no                | Persistent connection, push from server; not what we need. |
| gRPC (HTTP/2)     | yes                                      | partial      | no                | Typed RPC + streaming, but ties us to a custom server.     |
| Custom TCP        | yes                                      | no           | no                | Insane to ship and maintain.                               |

## Recommendation: HTTP/2 + REST, content-addressed by hash

Why:

- **Direct cloud-storage compatibility.** `PUT /cache/:hash` over HTTPS
  is what S3, R2, GCS, Azure Blob, MinIO all already speak. The "server"
  can literally be a bucket with no custom code on day one.
- **CDN at the edge.** HEAD and GET responses are cacheable by URL —
  CloudFront/Fastly/Cloudflare/Bunny all sit in front for free.
- **Debuggable.** `curl -I https://cache.example.com/v1/<hash>` is a
  one-liner. No protocol viewer needed.
- **HTTP/2 solves the "many small requests" pain.** A single connection
  multiplexes hundreds of concurrent HEAD checks; no head-of-line
  blocking, no connection storm on the client. This is what mostly
  obviates the need for batch endpoints (see below).
- **Auth is solved.** Bearer token via header, or pre-signed URLs for
  direct-to-storage uploads. Both are bog standard.

We explicitly reject:

- **WebSocket.** No server push needed; loses CDN; loses S3 fronting.
- **gRPC.** Locks us to a custom server (no S3 direct), adds proto
  schemas, demands a heavier client. The "streaming and typed" features
  don't outweigh the loss of S3 fronting for this access pattern.
- **Custom TCP.** Build/maintain a network protocol for a build tool?
  No.

## Endpoints

CAS-style: the hash is the entire identity. Each entry has metadata
(JSON) and outputs (a single compressed archive).

```
HEAD  /v1/cache/<hash>
        → 200 if entry exists, 404 if not.
        → Cacheable at the edge.

GET   /v1/cache/<hash>
        → 200 + tarball stream (Content-Type: application/x-tar+zstd).
        → Headers: x-vzn-task-id, x-vzn-exit-code, x-vzn-duration-ms,
                   x-vzn-stdout-bytes, x-vzn-stderr-bytes.
        → Body layout (inside the tarball):
            meta.json          # CacheEntry shape from docs/modules/cache.md
            outputs/...        # project-relative paths
        → Cacheable at the edge.

PUT   /v1/cache/<hash>
        → Request body: same tar+zstd shape as GET response.
        → 201 on first write, 200 on idempotent re-write
          (entries are content-addressed, so duplicate writes are no-ops).
        → 4xx on auth/quota errors; 5xx on storage errors → client retries.
        → NOT cacheable.
```

Versioning: `/v1/` segment. Bump on wire-incompatible changes. The
in-band `CACHE_VERSION` (currently `vzn-cache-v9`) is folded into the
hash itself, so format-bumps just appear as new keys; the URL version
is for the _protocol_ (response headers, archive layout).

## Batch endpoints: only one, only at run start

**Per-hash endpoints are the right default.** They're cacheable at the
edge, simple to authorize, idempotent, and easy to retry per-entry on
failure. HTTP/2 multiplexing makes 200 parallel HEADs over one
connection cheap.

**The single justified batch endpoint:**

```
POST  /v1/cache/has
        Body: { "hashes": ["abc...", "def...", ...] }
        → { "hits": ["abc...", ...], "misses": ["def...", ...] }
```

Why this one is worth it:

- Called _once_ at the start of a run, with the full hash list.
- Saves N round trips on cold-CDN reads (when nothing is at the edge yet).
- Lets the orchestrator front-load the cache check: schedule everything
  that's a guaranteed hit first, optimistically execute the misses.
- Not on the read-cache hot path — that's still per-hash GET (so the CDN
  caches it).

What we explicitly DON'T batch:

- **GET** — outputs vary in size from 0 bytes to 100s of MB. Batching
  is bad here: a slow large entry blocks the small fast ones; single
  failures invalidate the whole batch; CDN can't cache an aggregate
  response.
- **PUT** — entries complete at different times. Streaming each one
  immediately gives faster reuse by other machines.
- **HEAD on the hot path** — HTTP/2 multiplexing already makes 200
  parallel HEADs cheap.

Rule of thumb: batch operations that are _latency-bound_ and _small_;
keep operations that are _bandwidth-bound_ or _variable-sized_
per-request.

## Compression

Use **zstd** for the output tarball. ~3x faster than gzip at equivalent
ratios, native in Node 22+ (`node:zlib` `createZstdCompress` /
`createZstdDecompress`), and supported by every major HTTP stack. Apply
at archive level (`outputs.tar.zst`), not as `Content-Encoding` — gives
us deterministic byte layout for content-addressing without leaking the
HTTP layer's encoding choice into the cache identity.

## Authentication

Two modes:

1. **Bearer token** (`Authorization: Bearer ...`) for hosted cache
   servers. Token in `VZN_CACHE_TOKEN` env var. Standard, easy to
   rotate, easy to scope per project.
2. **Pre-signed URLs** when fronting S3-compatible storage directly.
   Client makes a side call to a tiny "signer" service that returns a
   URL with an attached signature; client then PUTs/GETs straight to
   the bucket. Lets users self-host with just a bucket + a 50-line
   signer, no full cache server.

For v1, ship bearer-token only. Pre-signed URLs are a v2 follow-up.

## Storage backends (server side)

The protocol is backend-agnostic. Day-one targets we can verify
against:

- **A plain S3-compatible bucket.** Server is a thin proxy that
  translates `/v1/cache/<hash>` to `s3://bucket/v1/<hash>/`. Works with
  AWS S3, R2, MinIO, Backblaze B2.
- **A Vercel/Turbo-style hosted service.** Same wire protocol; their
  server is their problem.

We do not standardize on "the server is just S3" because:

- Real cache servers want auth (which S3 alone doesn't model well).
- They want quota/eviction policies the protocol shouldn't dictate.
- A REST proxy is a few hundred lines; the value of a separate server
  abstraction is worth that cost.

## Failure handling

- **Network error on HEAD/GET**: treat as miss, run the task, attempt
  PUT after. Don't fail the user's build over a flaky cache.
- **Network error on PUT**: log a warning, don't fail. The task already
  succeeded; the only loss is the cache entry.
- **Timeout**: per-request budget (default 10s for HEAD, 60s for GET,
  120s for PUT). On timeout, behave as miss/no-write.
- **Server 5xx**: same — degrade to no-cache, log.
- **Server 4xx other than 404**: surface as an error (auth/quota issues
  should be visible).

The local cache layer stays in front: a remote miss with a local hit
restores from local; a remote hit can populate local. Composability is
free if the `Cache` interface (`src/cache.ts`) gets a `RemoteCache`
implementation alongside the existing local one, and a `LayeredCache`
wraps both.

## Client implementation sketch

`src/cache.ts` today exposes:

```ts
class Cache {
  key(input): Promise<string>
  get(hash): Promise<CacheEntry | null>
  restoreOutputs(hash, projectDir): Promise<void>
  save({ hash, entry, projectDir, outputFiles }): Promise<void>
}
```

We keep that surface and add two impls:

- `LocalCache` — today's filesystem implementation.
- `RemoteCache` — HTTP/2 client; same methods.
- `LayeredCache(localCache, remoteCache)` — `get` tries local then
  remote (and writes through to local on remote hit); `save` writes to
  both. Hash derivation lives outside (it's a pure function of inputs).

Configuration: `vzn.config.ts` workspace block gains:

```ts
defineWorkspace({
  cache: {
    remote: {
      url: 'https://cache.example.com',
      // or read from process.env.VZN_CACHE_URL
      tokenEnv: 'VZN_CACHE_TOKEN',
    },
  },
})
```

`--no-cache` continues to mean "skip local AND remote". A new
`--remote-cache=off` (or `--local-cache=off`) lets you bypass one tier.

## Open questions (not blockers for v1)

- **Garbage collection / retention** — server policy, not protocol.
  Hashes are immutable, so "delete entries older than N days" is the
  obvious knob, but cache-warming workflows might want pin/keep
  semantics. Leave as a server concern.
- **Project-level multi-tenancy** — bearer tokens scoped per
  `(team, project)` should suffice. Don't try to model it in the
  protocol.
- **Build provenance / signing** — out of scope for v1; add as
  optional headers later (sigstore-style detached signatures).
- **Resumable PUTs** for very large outputs — punt to v2. If/when we
  see real-world entries >500MB, revisit.

## Why not what NX / Turbo do

- **Turborepo** uses a flat HTTP REST with bearer tokens (`POST
/v8/artifacts/:hash`, `GET /v8/artifacts/:hash`). Single endpoint per
  hash, no batch. We're proposing essentially the same shape — they got
  the design right; the only thing we add is the optional batch-exists
  endpoint and we use zstd instead of their gzip-only.
- **NX Cloud** has a richer surface (file deduplication, distributed
  task execution, run UI). That's a product, not a cache; their cache
  protocol underneath is also HTTP REST. We're not building a product
  on top; we're building an open protocol.
- **Bazel Remote Cache** uses gRPC (over HTTP/2) with a separate CAS
  service for per-file content addressing. Better for huge polyglot
  monorepos with massive file overlap between actions; overkill for our
  scale and incompatible with plain-bucket backends.

## Summary

- **HTTP/2 + REST**, content-addressed by hash.
- **Per-hash endpoints** for HEAD/GET/PUT — CDN-cacheable, S3-friendly,
  individually retriable.
- **One batch endpoint** (`POST /v1/cache/has`) called once at run
  start to amortize the round-trip cost of cold existence checks.
- **zstd** archives, **bearer token** auth, **pre-signed URLs** in v2.
- **Layered with the local cache** so the wire is only hit on local
  miss.
- **No WebSocket, no gRPC, no custom protocol.**

Everything beyond this is implementation.
