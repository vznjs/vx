# Remote cache — protocol design

> **Status: implemented** (v1). Wire client in `src/remote-cache.ts`,
> tar.gz pack/unpack in `src/cache-archive.ts`, layered with the local
> cache in `src/layered-cache.ts`. Orchestrator picks it up automatically
> when `VZN_REMOTE_CACHE_URL` + `VZN_REMOTE_CACHE_TOKEN` are set.
> See "Configuration" at the bottom for env vars.

## What we're solving

The local cache (`docs/caching.md`) makes one machine's repeat runs fast.
A remote cache lets a team or CI fleet share entries: a task computed on
one machine becomes a cache hit for everyone else with the same inputs.

Concretely, every `vzn run` invocation:

1. Computes N task cache keys (one per task in the resolved graph).
2. For each key, decides if it can replay or must execute.
3. After execution, persists the entry so future runs (here or
   elsewhere) can hit it.

Remote cache layers on top of the local cache: local-then-remote on
reads (with remote hits hydrating local), local-sync + remote-async on
writes (failed uploads never fail the user's run).

## TL;DR

**We adopt Turborepo's `/v8/artifacts/` HTTP spec verbatim** for the
wire protocol. This gives us day-one compatibility with the existing
OSS turbo-compatible cache server ecosystem (`ducktors/turborepo-remote-cache`,
`Fox32/openturbo-remote-cache`, `felixmosh/turborepo-gh-artifacts`,
`turbo-remote-cache-rs`) — multi-tenant, S3/MinIO/R2/GCS-backed,
production-tested, self-hostable.

The tar layout **inside** our artifacts is our own — a structured
`meta.json` plus an `outputs/` tree. We do not mimic Turbo's interior
file conventions (`.turbo/turbo-<task>.log` etc.). The wire body is
opaque to cache servers, so the interior is invisible to the ecosystem
we're piggybacking on.

What we don't promise: cross-tool _cache reuse_. Our key derivation
differs from Turbo's, so a `vzn run` will never look up a hash that a
`turbo run` wrote (and vice versa). The wire-spec compatibility is for
ecosystem leverage (servers, hosted backends, tooling that operates at
the HTTP layer); it does not give cross-runner artifact swappability.

## Access pattern

- **Read-heavy.** A typical CI run has 80-95% cache hits. The hot path
  is HEAD/GET, not PUT.
- **Many small lookups.** A monorepo with 200 tasks issues 200 existence
  checks at the start of a run, mostly in parallel.
- **Few large transfers.** A `build` output can be tens of MB; a `test`
  output might be 0 bytes (caching the no-op success).
- **Bursty.** Concurrency = `os.cpus().length`; dozens of parallel
  ops then idle.
- **Per-machine sequential within a task.** The local orchestrator
  schedules a given hash once; multiple machines can race for the same
  hash — last-writer-wins is fine because entries are content-addressed.

## Why HTTP REST (and not WebSocket / gRPC / custom)

- **Direct cloud-storage compatibility.** PUT/GET by hash is what S3,
  R2, GCS, Azure Blob, MinIO speak. The "server" can be a bucket fronted
  by a tiny signer.
- **CDN at the edge.** HEAD and GET responses are cacheable by URL.
- **HTTP/2 multiplexing** solves "many small requests" — one connection,
  many concurrent streams, no head-of-line blocking.
- **Debuggable.** `curl -I https://cache.example.com/v8/artifacts/<hash>`.
- **Bearer auth is universal.**

Rejected:

- **WebSocket.** No server push needed; loses CDN; loses S3 fronting.
- **gRPC.** Locks us to a custom server (no S3 direct), proto schema
  surface, heavier client.
- **Custom TCP.** Maintain a network protocol for a build tool? No.

## Endpoints (Turborepo `/v8/artifacts/` spec)

Path prefix is `/v8/artifacts/`. Vercel has held this version stable
for years; the OSS ecosystem converged on it.

```
HEAD  /v8/artifacts/{hash}?teamId=&slug=
        → 200 if entry exists, 404 if not.
        → Cacheable at the edge.
        → Authorization: Bearer <token>.

GET   /v8/artifacts/{hash}?teamId=&slug=
        → 200 + application/octet-stream (tarball stream).
        → Response headers:
            x-artifact-duration       # ms, integer
            x-artifact-tag            # optional HMAC, opt-in
        → Cacheable at the edge.

PUT   /v8/artifacts/{hash}?teamId=&slug=
        → Request body: application/octet-stream (tarball).
        → Request headers:
            Authorization: Bearer <token>
            Content-Type: application/octet-stream
            Content-Length: <bytes>
            x-artifact-duration       # ms, integer
            x-artifact-tag            # optional HMAC
            x-artifact-client-ci      # optional, name of CI provider
            x-artifact-client-interactive  # optional, "1" if interactive
        → 200/201 on success.
        → NOT cacheable.

POST  /v8/artifacts                          (batch existence)
        → Body: { "hashes": ["abc...", ...] }
        → Response: { "<hash>": { "size": N, "taskDurationMs": N, "tag": "..." }, ... }
        → Hashes absent from the response are misses.
        → Called once at start of a run to amortize cold-CDN existence checks.

POST  /v8/artifacts/events                    (telemetry — NOT SHIPPED in v1)
        → Body: array of { sessionId, source, hash, event, duration }
        → Compatible servers accept its absence.
```

Multi-tenancy: `teamId` and `slug` are query parameters, treated as
opaque tenant identifiers. Configurable via `VZN_REMOTE_CACHE_TEAM_ID`
and `VZN_REMOTE_CACHE_SLUG`.

## Tar interior (ours, not Turbo's)

The wire body is opaque `application/octet-stream` — cache servers
store bytes, they don't inspect. We pick the inside layout:

```
<tarball, gzipped>
├── meta.json
└── outputs/
    └── <project-relative paths>
        ├── dist/index.js
        └── ...
```

Components:

- **`meta.json`** at the tar root — schema is the `CacheEntry` from
  `docs/modules/cache.md` (taskId, command, exitCode, durationMs,
  stdout, stderr, storedAt). One structured object with named fields.
- **`outputs/`** subtree mirrors the project-relative paths declared
  in `cache.outputs.files`. On restore the contents are copied back
  into the project directory.

We do _not_ adopt Turbo's interior convention (`.turbo/turbo-<task>.log`
combined log file). Servers don't inspect the body, and our orchestrator
needs stdout/stderr stream identity preserved for replay — Turbo's
combined log file would force `[STDOUT]/[STDERR]` line markers, which
is ugly. Keeping our own interior costs us nothing at the ecosystem
layer.

## Compression

**gzip** via system `tar -czf`. We initially scoped zstd (faster at
equivalent ratios) but gzip ships in every `tar` binary, costs no
dependency, and the bottleneck for cache transfer is network not CPU.
zstd remains an easy follow-up: swap `-z` for `--zstd` once we want it.

## Pack/unpack

`src/cache-archive.ts`:

```ts
packArchive(stageDir): Promise<Uint8Array> // tar -cz, streams to bytes
unpackArchive(buf, destDir): Promise<void> // tar -xz from stdin
packAndDiscard(stageDir): Promise<Uint8Array>
```

Shells out to system `tar` via `Bun.spawn`. Streaming stdin/stdout so
no archive bytes ever touch disk in the happy path.

## Authentication

**v1 (shipped):** Bearer token (`Authorization: Bearer ...`). Token in
`VZN_REMOTE_CACHE_TOKEN` env var. Standard, easy to rotate, easy to
scope per project.

**v1.5 (optional):** Payload signing via `x-artifact-tag` header,
matching Turbo's HMAC scheme. We send it on PUT when the client
configures a signing key; we receive it on GET but don't currently
verify. Off by default; opt-in for users who don't trust their cache
server's transport.

**v2 (planned):** Pre-signed URLs when fronting S3-compatible storage
directly. Client makes a side call to a tiny "signer" service, then
PUT/GET straight to the bucket. Lets users self-host with just a bucket

- a 50-line signer, no full cache server.

## Composition with the local cache

`LayeredCache(local, remote)` wraps the existing `Cache` interface in
`src/cache.ts`. Same surface — `key/get/restoreOutputs/save/recordRun/
stats/prune/close` — orchestrator callers don't change.

Behavior:

- **`get(hash)`**: try local first. On local miss, fetch from remote.
  On remote hit, unpack into a temp stage, materialize into local via
  `local.save()`, return the now-local entry. Future reads hit local.
- **`save(args)`**: write to local synchronously. Then stage, pack, and
  PUT to remote. Remote errors are logged via `onRemoteError`, never
  thrown — the task already succeeded.
- **`key/recordRun/stats/prune/restoreOutputs/close`**: pure delegation
  to local.

Orchestrator integration is in `wrapWithRemoteCache()` in
`src/orchestrator.ts`: when `VZN_REMOTE_CACHE_URL` and
`VZN_REMOTE_CACHE_TOKEN` are both set, the local `Cache` is wrapped in
a `LayeredCache`. Otherwise the orchestrator uses the local cache
directly.

## Failure handling

- **Network error on HEAD/GET**: caller treats as a miss; the orchestrator
  runs the task, attempts PUT after. Doesn't fail the user's build.
- **Network error on PUT**: log a warning, don't fail. The task already
  succeeded; the only loss is the remote cache entry.
- **Timeout**: per-request budget (default 60s, configurable via
  `VZN_REMOTE_CACHE_TIMEOUT_MS`). On timeout, behave as miss/no-write.
- **Server 5xx**: same — degrade to local-only, log.
- **Server 4xx other than 404**: surface as a `RemoteCacheError` so
  auth/quota issues are visible.

## Why this is the right move

- **Ecosystem.** A pre-alpha tool gets a mature, multi-tenant,
  self-hostable cache server (ducktors) on day one. The OSS work has
  been done; we don't rebuild it.
- **No vendor lock.** Pure HTTP REST + bearer auth. Any HTTP backend
  works. Vercel doesn't control our keys, format, or pricing.
- **Future-proof.** If we later want to deviate (richer batch metadata,
  per-file CAS like Bazel), we add `/v9/` endpoints and run both in
  parallel. Versioning is part of the spec.
- **Spec is already public.** Anyone implementing the server side has
  a reference, OpenAPI doc, and four reference implementations.

## What we explicitly skip from Turbo

- **`POST /v8/artifacts/events`** — telemetry. Compatible servers
  accept its absence; we don't ship it in v1.
- **`x-artifact-client-ci` / `x-artifact-client-interactive` headers
  on every PUT** — we accept these as optional config but don't auto-
  populate them. Cosmetic for dashboards; not part of correctness.
- **Turbo's tar interior** — see "Tar interior" above. We keep our own
  layout. The wire body is opaque so this is invisible to compatible
  servers.

## Configuration (v1, shipped)

| Env var                       | Required? | Notes                                       |
| ----------------------------- | --------- | ------------------------------------------- |
| `VZN_REMOTE_CACHE_URL`        | yes       | Base URL, e.g. `https://cache.example.com`. |
| `VZN_REMOTE_CACHE_TOKEN`      | yes       | Bearer token sent on every request.         |
| `VZN_REMOTE_CACHE_TEAM_ID`    | no        | Sent as `?teamId=` (Turbo tenancy).         |
| `VZN_REMOTE_CACHE_SLUG`       | no        | Sent as `?slug=`.                           |
| `VZN_REMOTE_CACHE_TIMEOUT_MS` | no        | Per-request timeout. Default `60000`.       |

Missing either of the two required vars → local cache only. The
orchestrator logs `remote cache: <url>` at the top of a run when the
remote layer is active.

`vzn.config.ts`-based remote-cache configuration is on the roadmap
once workspace-config loading lands (see active workstreams in
`CLAUDE.md`).
