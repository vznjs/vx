# `remote-cache.ts` — HTTP client for the Turborepo `/v8/artifacts/` wire

## Purpose

Wire-level only. Speaks the Turborepo Remote Cache HTTP spec — same
endpoints, headers, and tenancy convention so we interop with the OSS
ecosystem (`ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`,
Vercel's hosted cache).

This module knows nothing about local storage, tar archives, or how the
orchestrator uses the cache. Those concerns live in `layered-cache.ts`
and `cache-archive.ts`.

## Public surface

```ts
export class RemoteCache {
  constructor(config: RemoteCacheConfig)

  has(hash: string): Promise<boolean>
  get(hash: string): Promise<RemoteGetResult | null>
  put(hash: string, body: ArrayBuffer | Uint8Array, meta: RemotePutMetadata): Promise<void>
  batchExistence(hashes: readonly string[]): Promise<Record<string, RemoteBatchInfo>>
}

export interface RemoteCacheConfig {
  baseUrl: string
  token: string
  teamId?: string
  slug?: string
  timeoutMs?: number // default 60_000
}

export class RemoteCacheError extends Error {
  readonly status: number
  readonly cause?: unknown
}
```

## Endpoints

| Verb   | Path                                 | Purpose                 |
| ------ | ------------------------------------ | ----------------------- |
| `HEAD` | `/v8/artifacts/{hash}?teamId=&slug=` | Existence check         |
| `GET`  | `/v8/artifacts/{hash}?teamId=&slug=` | Download artifact bytes |
| `PUT`  | `/v8/artifacts/{hash}?teamId=&slug=` | Upload artifact bytes   |
| `POST` | `/v8/artifacts`                      | Batch existence query   |

Auth: `Authorization: Bearer <token>`.
Tenancy: `teamId` and `slug` query params (opaque identifiers; Turbo's names kept verbatim for compatibility).

## Headers

On `PUT`:

- `Content-Type: application/octet-stream`
- `Content-Length`
- `x-artifact-duration` (task duration in ms)
- `x-artifact-tag` (optional HMAC of the body; we send it when configured)
- `x-artifact-client-ci`, `x-artifact-client-interactive` (optional)

On `GET` response:

- `x-artifact-duration`, `x-artifact-tag` — surfaced via `RemoteGetResult`.

## Behavior

- 404 from HEAD/GET → returned as `false` / `null` (not an error).
- Non-2xx HTTP otherwise → `RemoteCacheError` with `.status`.
- Network error → `RemoteCacheError` with `.status = 0` and `.cause`.
- Per-request timeout via `AbortController` (default 60s).
- `batchExistence([])` short-circuits without an HTTP request.

## What this does NOT do

- No tar packing/unpacking. That's `cache-archive.ts`.
- No local caching, no key derivation. The hash is supplied by the
  caller (typically `Cache.key()`).
- No HMAC validation on responses (we send `x-artifact-tag` but don't
  verify the one we receive).
- No `POST /v8/artifacts/events` telemetry.

## Tests

`src/remote-cache.test.ts` spins a real in-process `Bun.serve()` HTTP
server and asserts every header / query / response-code path. Network
errors and timeouts are covered.

## Replacing this module

To target a different remote backend (raw S3, custom binary protocol,
etc.), replace this file and keep the four public methods plus
`RemoteCacheConfig` / `RemoteCacheError`. `LayeredCache` is the sole
consumer; it doesn't peek inside `RemoteCache`.
