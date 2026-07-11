# S3-compatible blob backend — no artifact bytes at rest on the controller

> **Status:** approved (owner directive, 2026-07-11) — "we cannot store
> cache on controller need to connect with s3 compat bucket".
>
> Builds the serve half of the offload seam
> `native-cache-wire-2026-07.md` designed in: a GET may answer
> `307 Location: <pre-signed blob URL>`, and the shipped
> `NativeCacheClient` already follows exactly one hop, dropping the
> bearer + `x-vx-cache-scope` cross-origin. Supersedes the storage half
> of `presigned-artifacts-2026-07.md` P2 (same S3/SigV4 approach, minus
> its Turbo-wire premise, which died with the wire).

## Target state in one paragraph

`vx-cloud serve` configured with an S3-compatible bucket holds **zero
artifact bytes at rest**. GET redirects the client to a short-lived
pre-signed bucket URL (the client fetches the bytes directly — the
controller never proxies a download). PUT still flows THROUGH the serve
— that is transit, not storage: the body spools to a temp file (cap +
zstd-magic enforced mid-stream exactly as today), uploads to the bucket,
and the temp is unlinked before the response — so immutability, byte
caps, the junk-body gate, and trust scopes remain server-enforced,
which is the reason P3-style PUT offload was rejected. Without S3
config, the local-dir store is byte-identical to today (solo/local dev
unchanged).

## The seam

`ArtifactStore` keeps ALL policy — trust-scope resolution, the
immutability 409, the streaming byte cap, the zstd-magic gate, sidecar
semantics, hash validation. Raw storage moves behind a `BlobBackend`:

```ts
export interface BlobBackend {
  /** Existence + metadata probe. */
  head(key: string): Promise<BlobStat | null>
  /** Upload a spooled file (exact length known). Metadata rides with it. */
  put(key: string, file: string, size: number, meta: Record<string, string>): Promise<void>
  /** A URL the CLIENT can GET directly, or null → the store serves bytes itself. */
  presignGet(key: string): Promise<string> | string | null
  /** Keys under a prefix (the /v1/artifacts list), newest-first best effort. */
  list(prefix: string): Promise<BlobListEntry[]>
}
```

- **LocalDirBackend** — today's flat-dir behavior verbatim:
  `presignGet` returns null, `handle()` serves `Bun.file` bytes with the
  sidecar headers. The `.duration`/`.digest` sidecar FILES stay a
  local-backend detail.
- **S3Backend** — `head` = S3 HEAD (metadata from `x-amz-meta-vx-*`),
  `put` = header-signed S3 PUT of the spooled file
  (`UNSIGNED-PAYLOAD` over TLS — the aws-cli streaming convention; the
  artifact's integrity story is the client-side `x-vx-digest`, not the
  transport hash), `presignGet` = a SigV4 query-signed GET URL
  (default TTL 300 s), `list` = ListObjectsV2 (XML, hand-parsed — keys,
  sizes, lastModified; `durationMs` is omitted in S3 mode rather than
  paying one HEAD per row).

Object keys mirror the local layout exactly, under an optional prefix:
`<prefix><bucket>/<tier>[/<sub>]/<hash>.tar.zst` — so the trust-scope
model (`cache-trust-scopes-2026-07.md`) holds by construction: the
pre-signed URL binds ONE server-derived scope key; the client never
influences which scope is signed.

## Wire behavior deltas

| Path | Local backend (unchanged) | S3 backend                                                       |
| ---- | ------------------------- | ---------------------------------------------------------------- |
| HEAD | dir stat                  | S3 HEAD per read scope (≤2)                                      |
| GET  | 200 + bytes + `x-vx-*`    | **307** `Location: <pre-signed URL>`; bytes come from the bucket |
| PUT  | temp → rename             | temp spool → S3 PUT → **unlink** (nothing rests on controller)   |

Metadata on the offloaded path: the S3 object carries
`x-amz-meta-vx-digest` / `x-amz-meta-vx-duration-ms` (set at PUT). The
bucket's GET response returns those verbatim, so `NativeCacheClient`
reads them as FALLBACKS for `x-vx-digest` / `x-vx-duration-ms` — digest
verification survives offload with zero extra serve round-trips (the
307 itself carries no metadata; adding it would cost the serve an S3
HEAD per GET).

Immutability on S3 is HEAD-then-PUT. The race (two writers pass the
HEAD) is benign: a content-addressed key's bytes are equal by
construction and S3 PUT is atomic — last-writer-wins of identical
bytes, never torn. Same posture as the local rename race (verified in
the 2026-07-10 review).

## SigV4 — hand-rolled, no AWS SDK

The repo rule from `presigned-artifacts-2026-07.md` stands: **no AWS
SDK** (its dependency closure is enormous and the needed surface is
four requests). One `sigv4.ts` module implements canonical
request → string-to-sign → signing key → signature for both forms:

- **Header-signed** (serve → bucket: PUT/HEAD/LIST) with
  `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
- **Query-signed** (the presigned GET handed to the client) —
  `X-Amz-Algorithm/-Credential/-Date/-Expires/-SignedHeaders/-Signature`.

Pinned by the AWS documentation's published test vector (the
`examplebucket/test.txt` presigned-GET example with the documented
`AKIAIOSFODNN7EXAMPLE` credentials → its known signature), plus
canonical-request unit tests (URI/query encoding edges: `/`, `=`,
unreserved set).

Path-style addressing by default (`<endpoint>/<bucket>/<key>`) — the
compatible-store baseline (MinIO, R2, Garage); AWS itself accepts it.

## Configuration (env, the deploy surface)

| Var                             | Meaning                                    |
| ------------------------------- | ------------------------------------------ |
| `VX_CLOUD_S3_ENDPOINT`          | `https://…` — presence ENABLES the backend |
| `VX_CLOUD_S3_BUCKET`            | bucket name (required with endpoint)       |
| `VX_CLOUD_S3_REGION`            | SigV4 region (default `auto`)              |
| `VX_CLOUD_S3_ACCESS_KEY_ID`     | credentials (required with endpoint)       |
| `VX_CLOUD_S3_SECRET_ACCESS_KEY` | credentials (required with endpoint)       |
| `VX_CLOUD_S3_PREFIX`            | optional key prefix (`vx-cache/`)          |
| `VX_CLOUD_S3_PRESIGN_TTL`       | seconds, default 300                       |

Partial config (endpoint without bucket/credentials) is a boot-time
hard error — never a silent fall-back to local storage, which would
violate the directive the moment it went unnoticed.

## Explicitly in / out

- **In**: artifact BYTES (`<hash>.tar.zst`) — the thing that grows
  unbounded and cannot live on the controller.
- **Out (stays on controller)**: the ingest analytics DBs, logs.db,
  fingerprints.db — small, pruned, and queried on every dashboard
  request; they are state, not cache. Also out: migrating an existing
  local artifact dir into the bucket (deploy fresh or warm naturally).
- **Out**: PUT offload (presigned client→bucket upload). It would
  weaken immutability and drop the junk-body/cap gates to
  client-trusted — the exact reason the presigned design deferred it.
  Revisit only if PUT proxy bandwidth measurably hurts a deployment.

## Verification plan

- SigV4 KATs (the AWS doc vector + encoding edges).
- A fake S3 server (Bun.serve: PUT/HEAD/GET/ListObjectsV2 over a temp
  dir) drives the full store suite in S3 mode: trust-scope matrix,
  immutability, junk-PUT 400, streaming cap.
- E2E: a real serve with S3 env → injected `NativeCacheClient` run →
  miss uploads THROUGH the serve into the fake bucket while the
  controller's artifact dir stays EMPTY (the directive, asserted) →
  local wipe → `restored-remote` via the 307 with the digest verified
  from `x-amz-meta-vx-digest` → tampered bucket object degrades to a
  miss and re-executes.
