# The vx-native cache wire — plugin-driven remote cache, Turbo compat dropped

> **Status:** approved (owner directive, 2026-07-10) — implementation in
> progress.
>
> Owner, verbatim: "I think the remote cache should be driven by a
> plugin. We should drop turbo compatibility, and use what make sense
> for vx cloud. Other could create turbo cache plugin."
>
> REVERSES: the 2026-05 "remote cache wire = Turbo `/v8/artifacts/`
> verbatim" decision, the 2026-06 Turbo-byte-compatible HMAC choice, and
> the 2026-07-10 Turbo `--preflight` client (`8fbd2c5`), whose premise
> was Turbo interop. Supersedes the WIRE premise of
> `presigned-artifacts-2026-07.md` (its blob-offload phasing survives,
> folded into the native wire below).

## Target state in one paragraph

Core carries **zero HTTP cache code**. It keeps exactly the seams: the
local `Cache`, the `LayeredCache` composition (policy gating, in-flight
dedup, remote provenance, never-fail degradation), a new minimal
`RemoteCacheLayer` interface, the `cache` plugin capability
(plugin.ts:60 — `cache(ctx): CacheLayer | undefined`), and a narrow
`RunOptions.remoteCache` embedder injection. The **wire is a plugin
concern**: `@vzn/vx-cloud` ships a vx-native client + server; a
third-party package can ship a Turbo-wire plugin against the same seams
(appendix recipe). `VX_REMOTE_CACHE_*` and the Turbo client leave core.

## The seam gap this fixes

`LayeredCache` today is typed against the CONCRETE Turbo client
(`layered-cache.ts:93` — `private readonly remote: RemoteCache`), so no
plugin can compose it with its own wire. The complete surface
LayeredCache consumes is three calls (layered-cache.ts:144,170,241):

```ts
/** What a remote cache layer must provide. Everything else —
 *  policy, dedup, provenance, degradation — is LayeredCache's job. */
export interface RemoteCacheLayer {
  /** Existence probe (the plan path's `--dry` prediction). */
  has(hash: string): Promise<boolean>
  /** Fetch an artifact; null = miss. Errors throw (LayeredCache
   *  degrades every throw to a miss via onRemoteError). */
  get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null>
  /** Store an artifact (fire-and-forget from LayeredCache's PoV). */
  put(hash: string, body: ArrayBuffer | Uint8Array, meta: { durationMs: number }): Promise<void>
}
```

`LayeredCache` retypes to this interface. The never-fail contract stays
where it is today: implementations THROW on failure; LayeredCache
catches everything and degrades to a miss (layered-cache.ts:321-327).

## The vx-native wire (v1)

Small by design — every feature has a consumer today. Namespace
`/v1/cache/…` on the vx-cloud serve, advertised by `/v1/meta` as
`cacheWire: 1` (the existing capability-probe pattern).

| Verb | Path              | Semantics                                                                             |
| ---- | ----------------- | ------------------------------------------------------------------------------------- |
| GET  | `/v1/cache/:hash` | 200 → artifact bytes (tar.zst) · 404 miss                                             |
| HEAD | `/v1/cache/:hash` | 200 / 404 existence probe                                                             |
| PUT  | `/v1/cache/:hash` | 200 stored · 400 invalid body (not zstd) · 409 immutable (hash exists) · 413 over cap |

> **As-shipped deviation (2026-07-10):** the server does NOT verify the
> digest (no 422) — the CLIENT verifies on GET, which covers the
> corruption directions that matter, and the server skips a hash pass
> per upload. What the server DOES gate is the body's zstd frame magic
> (400 otherwise): the store is immutable, so an accidental junk upload
> (empty body, proxy error page) must never permanently lock a key.

Headers (all vx-named, no Turbo shapes):

- `x-vx-duration-ms` (PUT request + GET response) — the producing task's
  duration; replaces `x-artifact-duration` + the `.duration` sidecar
  file as the wire form (the sidecar stays a server-internal detail).
- `x-vx-digest` (PUT request + GET response) — `xxh3:<16-hex>` over the
  artifact BYTES. **Structural integrity**: the server stores the digest
  as a sidecar and echoes it on GET; the client verifies against the
  received body (mismatch = corrupt = degrade to miss). Replaces the
  optional Turbo-HMAC bolt-on (see "defenses" below). As shipped the
  server does not re-hash uploads — see the deviation note above.
- `x-vx-cache-scope` (PUT/GET request) — the untrusted per-PR
  sub-partition, unchanged concept, now a spec'd part of the wire. The
  trust TIER never rides the wire: it stays derived server-side from
  the bearer (cache-trust-scopes-2026-07.md), which is the whole
  point of that design.
- Standard `authorization: Bearer`, `content-type:
application/octet-stream`, `content-length` (REQUIRED on GET
  responses — a sizeless body is refused client-side, preserving
  today's bounded-download posture).

**Streaming PUT**: the server writes the request body to a temp file as
it arrives (folding the digest incrementally), then renames — killing
the 512 MiB `req.arrayBuffer()` RAM buffering (artifact-store.ts:302),
the cost the presigned design called out. Caps enforced on ACTUAL bytes
streamed (413 mid-stream abort), not just content-length.

**Offload designed-in, not bolted on**: a GET **may** answer
`307 Location: <pre-signed blob URL>`; the client follows ONE redirect,
dropping `authorization` AND `x-vx-cache-scope` when the target origin
differs (a query-signed URL rejects a doubled credential; the scope
header is serve-facing identity a blob origin has no business seeing). That replaces the Turbo
OPTIONS-preflight dance with plain HTTP semantics and slots the
presigned design's Phase-2 blob backend in with zero client change.
SHIPPED server-side (2026-07-11): the S3-compatible blob backend
(`s3-blob-backend-2026-07.md`) answers exactly this 307 when
`VX_CLOUD_S3_*` is configured; the client's follow shipped first so
old clients never blocked the rollout.

**Rejected (no consumer today):** batch existence probes (would need a
`CacheLayer.has` batching seam in core — revisit if `--dry` on
1000-task remote graphs measures slow); compression negotiation (the
artifact IS tar.zst end-to-end); JSON metadata envelopes (headers
suffice; an envelope breaks streaming); resumable uploads.

## Where everything lives

- **Core** (`src/cache/`): `Cache`, `LayeredCache` (retyped),
  `RemoteCacheLayer` (new, exported on the façade), `CachePolicy`.
  DELETED: `remote-cache.ts` (client, preflight, HMAC, readBodyBounded
  moves out with it), `orchestrator/remote-cache-setup.ts`, the
  `VX_REMOTE_CACHE_*` env hatch, the façade `RemoteCache` export. The
  zstd-bomb refusal in `Cache.ingest` STAYS — it defends the local
  store from ANY untrusted bytes regardless of wire.
- **Cloud** (`packages/cloud/src/`): `native-cache.ts` — the
  `RemoteCacheLayer` client (bounded download, content-length refusal,
  digest verify, 307 follow, timeout). The serve handler mounts
  `/v1/cache/:hash` over the existing `ArtifactStore` (on-disk layout,
  trust partitions, tag/duration sidecars all unchanged — only the HTTP
  surface changes). `/v8/artifacts/:hash` is DELETED in the same wave
  (pre-alpha; every internal consumer moves in lockstep).
- **`RunOptions.remoteCache?: RemoteCacheLayer`** — the narrow embedder
  seam (mirrors `telemetrySinks`, options.ts:174): a host that already
  holds a client injects it; run() composes
  `LayeredCache(local, injected)`. Explicit injection WINS over the
  plugin consult (the host knows best; prevents double-wrapping when
  the workspace also declares `cloud()`).

## Internal consumers that move

1. **The `cloud()` plugin cache rung** (plugin.ts `buildCloudCache`) —
   constructs `NativeCacheClient` instead of the Turbo client. The
   `serveAdvertisesArtifacts` probe reads `cacheWire >= 1`.
2. **Distributed agents** (`dist/session.ts:28 wireAgentCacheEnv`) —
   today sets `VX_REMOTE_CACHE_URL/TOKEN` so core's env hatch wires the
   layer inside the agent's scoped runs. Replaced by passing
   `RunOptions.remoteCache` (the agent process is vx-cloud code and
   holds the native client already). Same for the submitter's targeted
   output materialization.
3. **Remote prefetch** (`orchestrator/remote-prefetch.ts`) — generic
   over `LayeredCache`; no change.
4. **UI artifact downloads** (`ui/src/api.ts downloadArtifact`) — GET
   `/v1/cache/:hash` instead of `/v8/artifacts/:hash`.
5. **`/v1/artifacts` list + provenance** — server-internal reads of the
   store; unchanged.

## Defense mapping (old → new)

| Today (Turbo client)                           | Native wire                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bounded download (`readBodyBounded`)           | Same code, moves into `native-cache.ts`                                                                                                                                                                                                                                                                                                                                                    |
| Content-length > cap refusal                   | Same, plus content-length REQUIRED                                                                                                                                                                                                                                                                                                                                                         |
| zstd-bomb refusal at ingest                    | Stays in core `Cache.ingest` (wire-agnostic)                                                                                                                                                                                                                                                                                                                                               |
| HMAC `x-artifact-tag` (opt-in, interop-shaped) | DROPPED. Replaced by structural `x-vx-digest` (corruption, both directions, always on) + the standing trust model: the serve is trusted infra, scopes are server-derived, offload URLs bind one scope key. HMAC's residual value (tamper evidence against a hostile MITM/CDN with a shared secret) moves to the third-party-plugin story for those who need Turbo-style deployment shapes. |
| Immutability 409                               | Kept, server-side (verified before rename)                                                                                                                                                                                                                                                                                                                                                 |
| PUT caps (content-length only → spoofable)     | Actual-bytes cap while streaming (the chunked-bypass fix carries over)                                                                                                                                                                                                                                                                                                                     |
| Turbo preflight (OPTIONS/Location)             | Plain `307` redirect follow, auth-dropping on cross-origin                                                                                                                                                                                                                                                                                                                                 |
| Scope from token / per-PR sub-scope            | Unchanged (the wire never carries the tier)                                                                                                                                                                                                                                                                                                                                                |

## Migration and the honest cut

`VX_REMOTE_CACHE_*` dies with core's hatch — the names are Turbo-shaped
(`TEAM_ID`, `SLUG`, `SIGNATURE_KEY`) and alias-mapping them onto a
different wire would misrepresent what they do. Pre-alpha, no
deprecation cycle. A user pointing vx at a Turbo-compatible server
(ducktors, Vercel hosted) **loses that today** and needs a Turbo cache
plugin that does not exist yet; the recipe below is the mitigation and
the extensibility guide documents it. vx-cloud users are unaffected —
`VX_CLOUD_URL`/`TOKEN` (or `vx-cloud connect`) drives the native wire
through the same one-connection ladder as before.

## The third-party Turbo plugin recipe (proof the seam suffices)

Everything needed is public on `'@vzn/vx'` after this wave:
`LayeredCache`, `RemoteCacheLayer`, `CachePolicy`, `resolveCacheScope`,
and the `VxPlugin.cache` capability (localCache + policy on the ctx).

```ts
import { LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class TurboRemote implements RemoteCacheLayer {
  // speak /v8/artifacts/:hash + x-artifact-* here, incl. HMAC if wanted
  async has(hash) {
    /* HEAD */
  }
  async get(hash) {
    /* GET → { body, durationMs } | null */
  }
  async put(hash, body, meta) {
    /* PUT */
  }
}

export function turboCache(opts: { url: string; token: string }): VxPlugin {
  return {
    name: 'acme/turbo-cache',
    cache: (ctx) => new LayeredCache(ctx.localCache, new TurboRemote(opts), { policy: ctx.policy }),
  }
}
```

## Phasing (each gate-green)

- **A — core seam** (no behavior change): `RemoteCacheLayer` interface,
  `LayeredCache` retype (the Turbo client trivially satisfies it),
  `RunOptions.remoteCache` + run.ts wiring, façade export. Existing
  tests green unchanged; layered-cache tests switch to a stub layer
  (better isolation regardless).
- **B — native wire**: serve `/v1/cache/:hash` (streaming PUT, digest,
  409/413/422) + `cacheWire: 1` on meta; `native-cache.ts` client;
  `buildCloudCache` switch; agents/submitter switch to
  `options.remoteCache`; UI download re-point; `/v8` deleted; native
  wire test suite (mirrors the old artifact-store trust matrix + the
  client defenses); agents e2e re-run.
- **C — Turbo removal from core**: delete `remote-cache.ts`,
  `remote-cache-setup.ts`, env wiring, `RemoteCache` façade export +
  boundary snapshot; delete/move the Turbo-specific tests
  (`remote-cache.test.ts` incl. the preflight suite dies with the
  client; `orchestrator-remote` e2e re-targets a stub
  `RemoteCacheLayer`); doc sweep.

## Doc impact

`comparison.md` (the "Remote cache wire" row + gaps §1 reframed:
plugin-driven, vx-native; Turbo = third-party plugin), `cli.md` (env
table: `VX_REMOTE_CACHE_*` rows removed; serve section: `/v8` →
`/v1/cache`), `caching.md` (remote layer = plugin capability),
`guides/extensibility.md` (the Turbo recipe), `guides/ci.md` +
`distributed-ci.md` (env mentions), `presigned-artifacts-2026-07.md`
(status note: wire premise superseded, offload folded here),
`modules/cache.md` / `remote-cache.md` module pages.

## Non-goals

- Shipping or maintaining a Turbo plugin ourselves.
- Blob-backend implementation (the 307 semantics reserve it; build per
  the presigned doc's P2 when a deployment needs it).
- Batch existence / resumable uploads / compression negotiation (no
  consumer).
- Changing the artifact FORMAT (tar.zst, `stdout` + `outputs/`), the
  cache key, or the on-disk store layout — CACHE_VERSION untouched.

## Open questions

- Should `x-vx-digest` eventually ride the telemetry fingerprint
  machinery instead of a second hash pass on PUT? (Today: hash the
  bytes at pack time — they're in memory already; measure before
  optimizing.)
- `--dry` remote prediction batching (see rejected list) if it ever
  measures slow on big graphs.
