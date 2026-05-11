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

## TL;DR

**We adopt Turborepo's `/v8/artifacts/` HTTP spec verbatim** for the wire
protocol. This gives us day-one compatibility with the existing OSS
turbo-compatible cache server ecosystem (`ducktors/turborepo-remote-cache`,
`Fox32/openturbo-remote-cache`, `felixmosh/turborepo-gh-artifacts`,
`turbo-remote-cache-rs`) — multi-tenant, S3/MinIO/R2/GCS-backed,
production-tested, self-hostable.

The tar layout inside our artifacts is **Turbo-shaped with a `meta.json`
sidecar** at the root. Turbo-compatible servers and tools see a familiar
artifact; our client gets richer structured metadata.

What we don't promise: cross-tool _cache reuse_. Our key derivation
differs from Turbo's, so a `vzn run` will never look up a hash that a
`turbo run` wrote. The wire-spec compatibility is for ecosystem leverage
(servers, tooling); not for cache sharing across runners.

## Access pattern (what the wire actually sees)

- **Read-heavy.** A typical CI run has 80-95% cache hits. The hot path
  is HEAD/GET, not PUT.
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

## Why HTTP REST (and not WebSocket / gRPC / custom)

Before getting into Turbo's specifics: the _family_ of protocols here is
HTTP REST, content-addressed by hash. Reasons:

- **Direct cloud-storage compatibility.** PUT/GET by hash is what S3,
  R2, GCS, Azure Blob, MinIO all already speak. The "server" can
  literally be a bucket fronted by a tiny signer.
- **CDN at the edge.** HEAD and GET by hash are cacheable by URL —
  CloudFront/Fastly/Cloudflare/Bunny all sit in front for free.
- **HTTP/2 multiplexing** solves the "many small requests" pain. A
  single connection multiplexes hundreds of concurrent HEAD checks; no
  head-of-line blocking, no connection storm on the client.
- **Debuggable.** `curl -I https://cache.example.com/v8/artifacts/<hash>`
  is a one-liner.
- **Auth is solved.** Bearer token via header.

Rejected:

- **WebSocket.** No server push needed; loses CDN; loses S3 fronting.
- **gRPC.** Locks us to a custom server (no S3 direct), adds proto
  schemas, demands a heavier client.
- **Custom TCP.** Build/maintain a network protocol for a build tool? No.

## Endpoints — Turborepo `/v8/artifacts/` spec

Path prefix is `/v8/artifacts/`. Vercel has held this version stable for
years; the OSS ecosystem has converged on it.

```
HEAD  /v8/artifacts/{hash}?teamId=&slug=
        → 200 if entry exists, 404 if not.
        → Cacheable at the edge.
        → Headers: Authorization: Bearer <token>.

GET   /v8/artifacts/{hash}?teamId=&slug=
        → 200 + application/octet-stream (tarball stream).
        → Response headers:
            x-artifact-duration       # ms, integer
            x-artifact-tag            # optional HMAC, see "Signing"
        → Cacheable at the edge.
        → Headers: Authorization: Bearer <token>.

PUT   /v8/artifacts/{hash}?teamId=&slug=
        → Request body: application/octet-stream (tarball).
        → Request headers:
            Authorization: Bearer <token>
            Content-Type: application/octet-stream
            Content-Length: <bytes>
            x-artifact-duration       # ms, integer
            x-artifact-tag            # optional HMAC, see "Signing"
            x-artifact-client-ci      # optional, name of CI provider
            x-artifact-client-interactive  # optional, "1" if interactive
        → 200/201 on success.
        → NOT cacheable.

POST  /v8/artifacts                          (batch existence)
        → Body: { "hashes": ["abc...", ...] }
        → Response: { "<hash>": { "size": <int>, "taskDurationMs": <int>, "tag": "<hmac>" }, ... }
        → Hashes absent from the response are misses.
        → Called once at start of a run to amortize cold-CDN existence checks.

POST  /v8/artifacts/events                    (telemetry — OPTIONAL)
        → Body: array of { sessionId, source, hash, event, duration }
        → We DO NOT ship this in v1. Compatible servers expect it but
          accept silence.
```

Multi-tenancy: `teamId` and `slug` are **query parameters**, not URL
segments. We treat them as opaque tenant identifiers — call them "tenant
id" in user docs, send them on the wire under Turbo's names so existing
servers work.

## Batch endpoints — exactly one, by design

**Per-hash endpoints are the default.** They're CDN-cacheable,
individually retriable, idempotent. HTTP/2 multiplexing makes 200
parallel HEADs cheap.

The single batch endpoint (`POST /v8/artifacts`) earns its keep:

- Called once at start of a run with the full hash list.
- Returns metadata (size, duration, tag), not just existence — useful
  for prioritization (small hits first) and integrity checks.
- Cold-CDN scenarios save N round trips.

We explicitly DON'T batch:

- **GET** — outputs vary in size from 0 bytes to 100s of MB. Batching is
  bad: a slow large entry blocks small fast ones; single failures
  invalidate the whole batch; CDN can't cache aggregate responses.
- **PUT** — entries complete at different times. Streaming each one
  immediately lets other machines reuse them sooner.
- **HEAD on the hot path** — HTTP/2 multiplexing makes parallel HEADs
  cheap, no need to batch.

## Artifact (tar) layout

The wire body is opaque `application/octet-stream` — cache servers store
bytes, they don't inspect. So we're free to pick the inside layout.

We follow Turbo's tar conventions for compatibility with tar-inspecting
tools, and add our own sidecar:

```
<tarball, zstd-compressed inside>
├── .turbo/turbo-<task>.log     # captured stdout+stderr, interleaved
├── meta.json                    # our richer structured metadata (sidecar)
└── <outputs at project-relative paths>
    ├── dist/index.js
    ├── dist/index.js.map
    └── ...
```

Components:

- **Output files** are at their project-relative paths inside the tar.
  This is Turbo's convention; common tar viewers see a familiar layout.
- **`.turbo/turbo-<task>.log`** holds captured stdout and stderr,
  interleaved as a single stream. On a cache hit, the client replays
  this to the terminal. Both Turbo clients and ours can read this file.
- **`meta.json`** is our sidecar. Schema is the `CacheEntry` from
  `docs/modules/cache.md` (taskId, command, exitCode, durationMs,
  outputFiles, stdout, stderr, storedAt). Turbo clients don't expect it
  and won't choke on it. Our client prefers it when present (it's
  structured), falls back to `.turbo/<task>.log` otherwise.

The `taskId`/`command` in `meta.json` are diagnostic — useful for
debugging cache contents — not part of the cache identity (those came
from the hash itself).

**stdout / stderr stream separation.** When we write the log file, we
write the two streams _interleaved with markers_ so we can split them
back out on replay:

```
[STDOUT] <line 1 of stdout>
[STDERR] <line 1 of stderr>
[STDOUT] <line 2 of stdout>
```

Turbo doesn't do this — its log file is a single undifferentiated
stream. Our marker scheme keeps Turbo's filename and broad shape while
preserving stream identity for our client. Turbo clients reading our
artifact see slightly noisier log output (the `[STDOUT]/[STDERR]`
prefixes), which is acceptable for the rare case of cross-tool
inspection.

## Compression

zstd, applied **inside** the tar (the tar body is zstd-compressed
bytes, not `Content-Encoding: zstd`). This matches Turbo 2.x.

Reasons for in-tar compression rather than HTTP-layer encoding:

- Deterministic byte layout — the compressed tar IS the artifact,
  identical bytes on every machine.
- No dependency on HTTP-stack negotiation (some proxies strip
  `Content-Encoding`).
- The cache server stores compressed bytes directly.

zstd over gzip: ~3x faster compression, similar ratio. Native in Node
22+ (`node:zlib` `createZstdCompress` / `createZstdDecompress`).

## Authentication

**v1:** Bearer token (`Authorization: Bearer ...`). Token in
`VZN_CACHE_TOKEN` env var. Standard, easy to rotate, easy to scope per
project.

**v1.5 (optional):** Payload signing via `x-artifact-tag` header,
matching Turbo's HMAC scheme (key in `TURBO_REMOTE_CACHE_SIGNATURE_KEY`
or our equivalent env var). Off by default; opt-in for users who don't
trust their cache server's transport.

**v2:** Pre-signed URLs when fronting S3-compatible storage directly.
Client makes a side call to a tiny "signer" service that returns a URL
with an attached signature; client then PUTs/GETs straight to the
bucket. Lets users self-host with just a bucket + a 50-line signer, no
full cache server.

## Storage backends (server side)

The protocol is backend-agnostic. Verified targets on day one:

- **Self-hosted via `ducktors/turborepo-remote-cache`** — Docker image,
  S3/R2/GCS/Azure Blob/MinIO/local FS backends, multi-tenant, bearer
  auth, signed payloads. The reference implementation; what most
  self-hosters will run.
- **A plain S3-compatible bucket via a thin proxy.** Translates
  `/v8/artifacts/<hash>` to `s3://bucket/v8/<hash>/`. Works with AWS S3,
  R2, MinIO, Backblaze B2.
- **Vercel's hosted Turbo cache.** If the user has a Vercel token, it
  works.

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

The local cache stays in front: a remote miss with a local hit restores
from local; a remote hit populates local. Composition is via a
`LayeredCache(local, remote)` wrapping the existing `Cache` interface
in `src/cache.ts`. No breaking API change.

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

We keep that surface and add:

- `RemoteCache` — HTTP/2 client speaking the `/v8/artifacts/` protocol.
- `LayeredCache(localCache, remoteCache)` — `get` tries local then
  remote (and writes through to local on remote hit); `save` writes to
  both. Hash derivation lives outside (it's a pure function of inputs).

Workspace config gains:

```ts
defineWorkspace({
  cache: {
    remote: {
      url: 'https://cache.example.com',
      tokenEnv: 'VZN_CACHE_TOKEN',
      // optional: tenancy mapped to Turbo's query params on the wire
      teamId: 'team_abc',
      slug: 'my-project',
      // optional: HMAC signing
      signatureKeyEnv: 'VZN_CACHE_SIGNATURE_KEY',
    },
  },
})
```

`--no-cache` continues to mean "skip local AND remote". A new
`--no-remote-cache` lets you bypass just the network tier.

## Open questions (not blockers for v1)

- **Garbage collection / retention** — server policy, not protocol.
  Turbo-compatible servers ship their own (ducktors has TTL config).
- **Build provenance / signing** — `x-artifact-tag` HMAC handles
  integrity; signed-by-builder identity is out of scope for v1.
- **Resumable PUTs** for very large outputs — punt to v2. If/when we
  see real-world entries > 500MB, revisit.
- **Per-task or workspace-level event/telemetry** — `POST /v8/artifacts/events`
  is part of the spec; we leave it unimplemented in v1 but reserve the
  hook to add later.

## What we explicitly skip from Turbo's wire

- **`POST /v8/artifacts/events`** — telemetry. Compatible servers accept
  its absence; we don't ship it in v1.
- **`x-artifact-client-ci` / `x-artifact-client-interactive`** —
  Vercel-specific request metadata for their UI. We can populate them
  later for completeness; v1 omits.
- **Turbo's exact tar layout for the log file content** — we use the
  same path (`.turbo/turbo-<task>.log`) but add `[STDOUT]/[STDERR]`
  prefixes to preserve stream separation. Compatible at the path/filename
  level, divergent in line format. Trade-off documented above.

## Why this is the right move

- **Ecosystem.** A pre-alpha tool gets a mature, multi-tenant,
  self-hostable cache server (ducktors) on day one. The OSS work has
  been done; we don't rebuild it.
- **No vendor lock.** The protocol is HTTP REST with bearer auth. Any
  HTTP backend works. Vercel doesn't control our keys, our format, or
  our pricing.
- **Future-proof.** If we later want to deviate (richer batch metadata,
  per-file CAS like Bazel, etc.), we add `/v9/` endpoints and run both
  in parallel for a transition period. Versioning is part of the spec.
- **Spec is already public.** Anyone implementing the server side has a
  reference, OpenAPI doc, and four reference implementations to study.

## Summary

- **`/v8/artifacts/` REST endpoints**, HTTP/2 multiplexed.
- **One batch endpoint** (`POST /v8/artifacts`) for run-start existence
  checks, returning size + duration + tag per hash.
- **Tarball inside** is Turbo-shaped (output files at project-relative
  paths + `.turbo/turbo-<task>.log`) with a `meta.json` sidecar at root
  for our structured metadata.
- **zstd** inside the tar, **bearer token** v1 auth, **HMAC payload
  signing** opt-in.
- **Multi-tenancy** via `?teamId=&slug=` query params (Turbo's names).
- **Layered with the local cache** via `LayeredCache` wrapping the
  existing `Cache` interface — no breaking API change.
- **Compatible with** `ducktors/turborepo-remote-cache`,
  `Fox32/openturbo-remote-cache`, and Vercel's hosted Turbo cache on
  day one. NX-compatible cache servers are out of scope.

Everything beyond this is implementation.
