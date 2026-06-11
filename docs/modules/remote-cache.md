# `src/cache/remote-cache.ts` — Turborepo `/v8/artifacts/` HTTP client

## Purpose

Wire-level only. Speaks the Turborepo Remote Cache HTTP spec — same
endpoints, headers, and tenancy convention so we interop with the OSS
ecosystem (`ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`,
Vercel's hosted cache).

This module knows nothing about local storage, tar archives, or how the
orchestrator uses the cache. Those concerns live in `layered-cache.ts`
and `cache.ts` — the artifact bytes pass through this client opaquely.

## Public surface

```ts
export class RemoteCache {
  constructor(config: RemoteCacheConfig)

  get(hash: string): Promise<RemoteGetResult | null>
  put(hash: string, body: ArrayBuffer | Uint8Array, meta: RemotePutMetadata): Promise<void>
}

export interface RemoteCacheConfig {
  baseUrl: string
  token: string
  teamId?: string
  slug?: string
  timeoutMs?: number // default 60_000
  signatureKey?: string // opt-in HMAC artifact signing
}

export class RemoteCacheError extends Error {
  readonly status: number
  readonly cause?: unknown
}
```

## Endpoints

| Verb  | Path                                 | Purpose                 |
| ----- | ------------------------------------ | ----------------------- |
| `GET` | `/v8/artifacts/{hash}?teamId=&slug=` | Download artifact bytes |
| `PUT` | `/v8/artifacts/{hash}?teamId=&slug=` | Upload artifact bytes   |

Auth: `Authorization: Bearer <token>`.
Tenancy: `teamId` and `slug` query params (opaque identifiers; Turbo's names kept verbatim for compatibility).

## Headers

On `PUT`:

- `Content-Type: application/octet-stream`
- `Content-Length`
- `x-artifact-duration` (task duration in ms)
- `x-artifact-tag` (HMAC artifact signature; sent when `signatureKey`
  is configured)

On `GET` response:

- `x-artifact-duration` — surfaced via `RemoteGetResult`.
- `x-artifact-tag` — verified against the body when `signatureKey` is
  configured; ignored otherwise.

## Artifact signing

Opt-in via `signatureKey` (env: `VX_REMOTE_CACHE_SIGNATURE_KEY`).
Byte-compatible with Turbo's scheme:

```
tag = base64( HMAC-SHA256( key, utf8(hash) || utf8(teamId ?? '') || body ) )
```

- PUT computes the tag over the outgoing bytes and sends it.
- GET verifies the response tag against the received body with
  `crypto.timingSafeEqual`. Mismatch **or missing tag** →
  `RemoteCacheError` (a signing deployment never silently accepts
  unsigned artifacts). `LayeredCache` degrades that error to
  `onRemoteError` + a cache miss.
- No key configured → no header on PUT, no verification on GET.

Full semantics in
[`design/remote-cache.md` § Authentication](../design/remote-cache.md#authentication).

## Behavior

- 404 from GET → returned as `null` (not an error).
- Non-2xx HTTP otherwise → `RemoteCacheError` with `.status`.
- Network error → `RemoteCacheError` with `.status = 0` and `.cause`.
- Per-request timeout via `AbortSignal.timeout` (default 60s).

## What this does NOT do

- No tar packing/unpacking. Artifact bytes are opaque; `cache.ts` owns the format.
- No local caching, no key derivation. The hash is supplied by the
  caller (typically `Cache.key()`).
- No `POST /v8/artifacts/events` telemetry.

## Tests

`tests/remote-cache.test.ts` spins a real in-process `Bun.serve()` HTTP
server and asserts every header / query / response-code path. Network
errors, timeouts, and the signing paths (tag on PUT, verify/mismatch/
missing-tag on GET, no-key passthrough) are covered.

## Replacing this module

To target a different remote backend (raw S3, custom binary protocol,
etc.), replace this file and keep `get`/`put` plus
`RemoteCacheConfig` / `RemoteCacheError`. `LayeredCache` is the sole
consumer; it doesn't peek inside `RemoteCache`.
