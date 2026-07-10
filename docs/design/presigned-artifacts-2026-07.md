# Pre-signed artifact URLs — design

> **Status (2026-07-10): the WIRE premise of this design is SUPERSEDED**
> by [`native-cache-wire-2026-07.md`](./native-cache-wire-2026-07.md) —
> the owner dropped Turbo compatibility, so the Turbo `--preflight`
> client (Phase 1, shipped then retired) and the "Turbo wire verbatim"
> rationale no longer apply. The blob-offload phasing SURVIVES, folded
> into the native wire: a `/v1/cache/:hash` GET may answer
> `307 Location: <pre-signed blob URL>`, and the native client already
> follows one redirect (auth-dropping cross-origin). The Phase-2 blob
> backend (S3/R2, GET offload only) remains the designed, unbuilt half.

> **Status:** proposal
>
> Closes `docs/comparison.md` §Gaps #1 (comparison.md:146-150:
> "pre-signed upload URLs remain"). Builds on / inherits (NOT
> re-litigated): trust scopes (`cache-trust-scopes-2026-07.md` —
> server-derived `<bucket>/<tier>`, untrusted never writes trusted,
> immutability 409), HMAC signing (Turbo-byte-compatible,
> remote-cache.ts:176-185), and the serve-hosted `/v8/artifacts` store
> (`packages/cloud/src/artifact-store.ts`).

## What we're solving

Every artifact byte transits the vx-cloud serve today. `RemoteCache`
(src/cache/remote-cache.ts) speaks GET/PUT/HEAD against
`/v8/artifacts/:hash` with a bearer on every request
(remote-cache.ts:216); the serve answers from a scope-nested flat dir
(artifact-store.ts:97-332). Two costs at scale:

1. **PUT buffers the whole body in serve RAM** — `req.arrayBuffer()`
   (artifact-store.ts:302), up to 512 MiB (artifact-store.ts:28) per
   concurrent PUT. A CI burst of large-artifact misses is real memory
   pressure on the single-process serve.
2. **The serve is the bandwidth chokepoint** — every warm CI run's GETs
   and every miss's PUT ride one box's NIC, even when the bytes could go
   straight to object storage (R2 zero-egress, S3 geo-proximate).

Pre-signed URLs are the standard fix: the server authorizes, the blob
store transfers. They exist precisely so **clients never hold blob
credentials** — the serve pre-signs; the client follows a URL. Turbo's
wire already has a mechanism for this, and vx's HMAC decision set the
precedent (decision log 2026-06: "byte-compatible … interop wins").
vx's client lacks it — that is the comparison gap.

## The Turbo preflight mechanism (verified)

Verified against `vercel/turborepo`
`crates/turborepo-api-client/src/lib.rs` (main branch, fetched
2026-07-10 — re-pin against the current release at implementation time):

- Opt-in via `--preflight` / `remoteCache.preflight: true`. When on, the
  client precedes each artifact request with **`OPTIONS <artifact-url>`**
  carrying `Access-Control-Request-Method: <GET|PUT>`,
  `Access-Control-Request-Headers: <names>` (names only, never values),
  and the bearer.
- The response's **`Location`** (absolute or relative; falls back to the
  original URL when absent) becomes the URL for the real request.
- **`Access-Control-Allow-Headers`** decides whether the bearer rides
  along: kept iff `*` or contains `authorization` (case-insensitive),
  dropped otherwise — a query-signed S3/R2 URL **rejects** a request
  that also carries `Authorization`.
- Invoked from `get_artifact`, `put_artifact`, AND `artifact_exists`.
  No 30x-with-body semantics to argue about — the preflight answers
  "where do I send this, and do I bring my token" before the transfer.

## Access pattern

- **GET dominates.** Every warm CI task is a GET (or a plan-path HEAD,
  remote-cache.ts:149-154); PUT fires only on a miss. Offload value
  concentrates on downloads.
- Typical artifacts are KB–MB; the repo's own compiled binaries run
  ~100 MB; cap 512 MiB both sides (remote-cache.ts:57).
- Preflight costs +1 RTT per operation — pure overhead against a
  non-redirecting server. Hence Turbo made it opt-in; so do we.

## Options considered (briefly)

- **(A) Turbo preflight/Location, verbatim.** _Chosen._ Interop both
  directions: vx's client works against Vercel + any preflight-capable
  server; stock Turbo clients get offload from a blob-backed vx serve.
  No new wire to version — it's the existing external `/v8` spec (vx's
  extension headers are additive).
- **(B) vx-native `/v1/presign` extension.** Rejected: a second wire for
  the same bytes, zero ecosystem leverage, core learns a non-Turbo
  protocol.
- **(C) Plain 302 redirects.** Rejected: PUT-with-body redirect handling
  varies by HTTP stack, and clients must know to strip `Authorization`
  cross-origin. The preflight exists because this is fragile.
- **(D) Do nothing.** Viable today — costed as Phase 0 below. Rejected
  as the end state: the PUT buffering + single-NIC ceiling are real, and
  the client half blocks interop with servers that already redirect.

## Recommendation

Adopt Turbo's preflight verbatim, phased so the security-hard part
ships last (or never):

1. **Core client:** opt-in preflight in `RemoteCache`. Ships alone;
   useful against third-party servers immediately.
2. **Serve, GET offload only:** a cloud-side S3-compatible blob backend
   (R2/MinIO/S3) behind the ArtifactStore; GET preflights answer with a
   pre-signed download URL. **PUT keeps proxying through the serve** —
   immutability 409 (artifact-store.ts:297-301), the tag sidecar
   (artifact-store.ts:318-319), the size cap, and write-scope derivation
   stay fully server-enforced, byte-identical to today.
3. **PUT offload (optional, on demand):** direct-to-blob uploads with an
   honestly-degraded immutability story (below).

## Concrete spec

### Client — `src/cache/remote-cache.ts` (core)

- `RemoteCacheConfig.preflight?: boolean`; env
  `VX_REMOTE_CACHE_PREFLIGHT=1` parsed in `remote-cache-setup.ts`
  (beside the existing knobs, remote-cache-setup.ts:40-53); mirrored as
  a `cloud()` option. Default OFF.
- When on: `get`/`put` issue the OPTIONS above, then run the existing
  request logic against the returned `Location`, dropping
  `Authorization` unless allowed. `has()` does NOT preflight (a HEAD has
  no body to offload; saves the RTT — deliberate minor divergence from
  Turbo's `artifact_exists`, invisible to servers).
- **All existing defenses apply unchanged to the redirected response**:
  the declared content-length refusal (remote-cache.ts:100-106),
  `readBodyBounded` (remote-cache.ts:67-90), and the downstream
  zstd-bomb checks run on whatever body comes back — no new trust in the
  blob origin.
- **Tag verification across a redirect:** the blob response won't carry
  `x-artifact-tag` (S3 returns user metadata as `x-amz-meta-*`;
  presigned response-header overrides can't inject arbitrary headers).
  The client accepts the tag from the **preflight response header** as a
  fallback when the body response lacks one. Safe: the tag is
  HMAC-verified against the shared secret (remote-cache.ts:122-134) — a
  wrong tag from any channel fails closed to a miss. A missing tag on a
  signing deployment stays the hard error it is today.

### Serve — `packages/cloud` (cloud only)

- New cloud-local `BlobBackend` interface (fs + s3): fs = today's dir
  I/O refactored behind it (default, byte-identical); s3 holds
  endpoint/region/credentials and pre-signs SigV4 URLs **hand-rolled
  over `node:crypto`, no AWS SDK** (~100 LOC HMAC chain — the vx-otel
  no-SDK precedent). Config: `--blob-store` + `VX_CLOUD_BLOB_*`. Only
  the serve ever holds blob credentials.
- **Object keys = the existing scope layout**:
  `<prefix>/<bucket>/<tier>[/<sub>]/<hash>.tar.zst` — exactly
  `readScopes`/`writeScope` (artifact-store.ts:59-73) as keys. The
  pre-signed URL binds one exact key, derived server-side from the
  request's `Principal` (serve.ts:468-473, threaded at serve.ts:716-717)
  — **the client never chooses the path**, so "untrusted never
  reads/writes outside its scopes" survives offload: URL issuance IS the
  authorization point.
- **GET preflight:** resolve which readable scope holds the object
  (existence probe in `readScopes` order — the same fall-through
  `findRead` does today, artifact-store.ts:137-148), pre-sign that key
  (short expiry, ~60 s), answer `Location` +
  `Access-Control-Allow-Headers` omitting `authorization` +
  `x-artifact-tag`/`x-artifact-duration` from the sidecars. Miss → no
  `Location` (client falls through to a plain GET → 404, per the
  verified client behavior).
- **PUT preflight (Phase 2):** answered WITHOUT `Location` — the client
  PUTs to the serve as today; the serve writes through the BlobBackend.
  Streaming the request body (instead of `req.arrayBuffer()`,
  artifact-store.ts:302) fixes the RAM buffering independently of any
  offload.
- `/v1/meta` advertises `presign: true` beside `artifacts: true`
  (serve.ts:662-664).
- **Format sentinel** (house rule): a `vx-store-version` marker object
  (`1`) at the prefix root, checked on boot — the blob twin of the fs
  store's trust-scope migration gate (artifact-store.ts:114-135).

### Immutability under direct PUT (Phase 3 — the honest part)

The 409-on-re-PUT **cannot be fully server-enforced** once clients write
straight to the blob store — the serve never sees the write. Mitigations:

1. **Existence-gate at preflight** — probe the write-scope key before
   issuing a PUT URL; exists → no `Location`, the client PUTs to the
   serve and gets the normal 409. Closes the common case.
2. **Short expiry (≤60 s)** bounds the overwrite window.
3. **`If-None-Match: *` conditional PUT** — S3 supports it (2024+); R2
   support to verify (open question #1). It can't be signed into the URL
   (a stock Turbo client wouldn't send the header and would 403), so the
   vx client sends it voluntarily; stock clients get #1+#2 only.
   Content-length/checksum conditions are impossible: the preflight
   carries header _names_, never values, so the serve never learns the
   body's length or digest before signing.
4. **Accept and document the residual:** within the window, an
   _already-authorized same-tier_ writer can overwrite. The
   security-critical invariant — untrusted never writes trusted — holds
   regardless (the key prefix is server-derived from the token). What
   degrades is defense-in-depth against an authorized poisoner — the
   same residual class the trust-scopes review accepted for
   untrusted-peer writes.

**Tag on direct PUT:** S3 ignores unsigned non-`x-amz-*` headers, so
`x-artifact-tag` is lost on a direct upload. vx extension (additive,
harmless to Turbo servers/clients): the vx client includes the computed
tag **value** on the PUT preflight OPTIONS; the serve persists the
sidecar then. A lying tag fails HMAC verification at read time →
degrades to a miss. Until Phase 3, signing deployments lose nothing:
PUT proxies, tags captured as today.

### What stays OUT of core

- **S3/SigV4/credentials/BlobBackend** — cloud package only. Core's
  provider-neutral rule holds trivially: the preflight is Turbo's own
  wire, and pre-signed URLs mean the core client needs zero blob
  awareness — it follows a URL.
- **The internal CAS seam stays internal.** `CASBackend`/`Digest`
  (src/cache/cas-backend.ts:25-34) remain unconsumed;
  cas-backend.ts:16-19 marks Cache rewiring as its own follow-up, and
  the artifact store deliberately did NOT import it
  (artifact-store.ts:5-7: "core internals stay internal"). The cloud
  `BlobBackend` mirrors the seam's _shape_ (put/get/has by hash) plus
  presign methods that don't belong on a byte-store interface.
  Exporting CASBackend from the façade just to subclass it in cloud
  would couple core to this roadmap for nothing.

## Phasing

- **Phase 0 — do nothing.** Honest cost of stopping here: the serve
  proxies fine at current scale (GETs stream via `Bun.file`,
  artifact-store.ts:286); the comparison gap stays open client-side; PUT
  RAM buffering persists (fixable by streaming-to-disk alone, no presign
  needed). If vx never hosts a large-artifact/high-throughput
  deployment, this is a defensible permanent answer.
- **Phase 1 — core client preflight.** ~1-2 days + tests. Independent
  value (Vercel + third-party interop); closes the comparison.md line.
- **Phase 2 — serve BlobBackend + GET offload + streamed PUT.** ~3-5
  days. All server-enforced invariants preserved; fs default untouched.
- **Phase 3 — PUT offload.** Only on demonstrated demand (a deployment
  whose PUT volume saturates the serve). Ships with the mitigations and
  the documented residual, or doesn't ship.

## What's out of scope

- Multipart/resumable uploads; CDN URL signing; GCS-native auth
  (S3-compat mode only); REAPI CAS bridge.
- Rewiring core `Cache` onto `CASBackend` (independent thread).
- Per-tier signing keys; retrofitting third-party Turbo servers.
- Replacing the fs store — it stays the default for the single-box serve.

## Test strategy

- **Client (core):** a two-fixture `Bun.serve` suite — fixture A answers
  OPTIONS with `Location` → fixture B. Pins: Location followed; bearer
  dropped unless allowed (`*` and listed forms); no-Location falls back
  to the original URL; tag-from-preflight verifies and a tampered
  redirected body still fails closed; `readBodyBounded` cap enforced on
  the redirected body; **preflight off = byte-identical requests to
  today** (regression pin).
- **Serve (cloud):** SigV4 presigner known-answer test (fixed
  key/date/region → exact signature vs the AWS documented example);
  scope-mapping matrix (untrusted GET preflight resolves
  `untrusted/<sub>` then `trusted`, never a peer sub-scope; trusted
  never receives an untrusted key); Phase-2 PUT-still-proxied pins (409
  - tag sidecar + 413 unchanged); fs-backend byte-identity when no blob
    is configured.
- **E2E vs MinIO:** a CI-optional job (no Docker daemon in the dev env —
  the docker.yml precedent); manual checklist until then.

## Open questions

1. Does R2 honor `If-None-Match: *` on PUT? (Phase 3; verify at impl.)
2. Preflight on `has()` — we skip it; confirm no third-party server
   _requires_ preflight for HEAD.
3. Multi-scope GET resolution on a blob backend costs 1-2 server-side
   HEADs per preflight; is a serve-side existence index worth the state?
4. Stock-Turbo-client behavior when OPTIONS returns non-2xx (error vs
   fall-through) — pin from source before Phase 2.
5. Should `cloud()` auto-enable client preflight when `/v1/meta`
   advertises `presign: true`?

## Why this is the right move

- **Interop is the whole point** — the same call as the HMAC tag:
  byte-level Turbo compatibility, both directions, day one.
- **The trust boundary survives offload by construction:** the presigned
  URL binds a server-derived scope key; issuance is the authz point, so
  the cache-trust-scopes guarantees need no re-argument.
- **The hard part is quarantined:** GET offload (the dominant traffic)
  keeps every server-enforced invariant; only Phase-3 PUT offload trades
  immutability enforcement, and only against demonstrated need.
- **Core stays provider-neutral and dependency-free:** one opt-in flag +
  an OPTIONS request in core; SigV4 and credentials live in cloud;
  clients never hold blob secrets at all.
- **Do-nothing is priced, not dismissed** — the proxy is fine at current
  scale; this design exists for the deployment shape where it isn't.
