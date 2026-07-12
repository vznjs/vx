// The vx-native remote-cache client — core's `RemoteCacheLayer` seam over
// the `/v1/cache/:hash` wire a vx-cloud serve hosts
// (docs/design/native-cache-wire-2026-07.md). Wire-level only: LayeredCache
// owns policy, in-flight dedup, provenance, and never-fail degradation —
// this client THROWS on every failure and LayeredCache degrades the throw
// to a cache miss.
//
// Defenses carried over from the retired Turbo client: bounded downloads
// (content-length REQUIRED + capped, plus a mid-stream cumulative cap so a
// lying/absent length can't defeat it) and clearable per-request timeouts.
// New: structural integrity via `x-vx-digest` (xxh3 over the artifact
// bytes) — the client verifies every GET body that carries one, so a
// corrupt store or truncating transport degrades to a miss, never a
// restored artifact.

import type { RemoteCacheLayer } from '@vzn/vx'

export interface NativeCacheConfig {
  /** Origin of the vx-cloud serve, e.g. https://cloud.example.com */
  baseUrl: string
  /** Bearer token; the server derives the trust tier from it. */
  token?: string
  /** Untrusted per-PR partition id, sent as `x-vx-cache-scope`. */
  cacheScope?: string
  /** Per-request timeout in ms. Default 60_000. */
  timeoutMs?: number
}

/**
 * Hard cap on a downloaded artifact body (compressed bytes). A malicious or
 * compromised remote (or a MITM answering a GET) must not be able to stream
 * an unbounded body into memory — the download aborts past this and the
 * layered cache degrades to a miss. Mirrors the server-side PUT cap.
 */
export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024

/**
 * Read a response body, aborting once cumulative bytes exceed `max`. Streams
 * via the body reader so a lying (or absent) content-length can't defeat the
 * cap. Falls back to `arrayBuffer()` only when the body isn't a stream.
 *
 * Exported for tests: the `max` param lets a unit test exercise the
 * mid-stream abort with a tiny cap instead of a 512 MiB body.
 */
export async function readBodyBounded(res: Response, max: number): Promise<ArrayBuffer> {
  const reader = res.body?.getReader()
  if (reader === undefined) return await res.arrayBuffer()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error(`artifact exceeds ${max}-byte download cap`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out.buffer
}

const DIGEST_RE = /^xxh3:[0-9a-f]{1,16}$/

function xxh3Digest(bytes: Uint8Array): string {
  return `xxh3:${Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')}`
}

// Hashes per `POST /v1/cache/batch` request. MUST stay ≤ the server's
// BATCH_HASH_CAP (artifact-store.ts) or the server 400s an over-cap chunk.
const BATCH_CHUNK = 1024

export class NativeCacheClient implements RemoteCacheLayer {
  // Remembers a serve that has no batch route (cacheWire < 2) so `hasMany`
  // probes it at most once per client lifetime, then declines.
  private batchUnsupported = false

  constructor(private readonly config: NativeCacheConfig) {}

  async get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null> {
    const res = await this.request('GET', this.artifactUrl(hash), { followOneRedirect: true })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`)
    // A sizeless body is refused — the bounded-download posture requires an
    // honest declared length (the mid-stream cap still guards a lying one).
    const declaredRaw = res.headers.get('content-length')
    if (declaredRaw === null || !/^\d+$/.test(declaredRaw)) {
      throw new Error(`GET ${hash} → response carries no content-length`)
    }
    const declaredLen = Number(declaredRaw)
    if (declaredLen > MAX_REMOTE_ARTIFACT_BYTES) {
      throw new Error(
        `GET ${hash} → artifact too large (${declaredLen} bytes > ${MAX_REMOTE_ARTIFACT_BYTES} cap)`,
      )
    }
    let body: ArrayBuffer
    try {
      body = await readBodyBounded(res, MAX_REMOTE_ARTIFACT_BYTES)
    } catch (err) {
      throw new Error(`GET ${hash} → body read failed: ${(err as Error).message}`)
    }
    // An offloaded response (a 307 followed to the bucket) carries the vx
    // metadata as S3 user metadata instead of the vx headers — fall back to
    // it, same validation.
    const digest = res.headers.get('x-vx-digest') ?? res.headers.get('x-amz-meta-vx-digest')
    if (digest !== null && DIGEST_RE.test(digest) && digest !== xxh3Digest(new Uint8Array(body))) {
      throw new Error(`GET ${hash} → x-vx-digest mismatch (corrupt artifact)`)
    }
    return {
      body,
      durationMs: parseIntHeader(
        res.headers.get('x-vx-duration-ms') ?? res.headers.get('x-amz-meta-vx-duration-ms'),
      ),
    }
  }

  async has(hash: string): Promise<boolean> {
    const res = await this.request('HEAD', this.artifactUrl(hash))
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`HEAD ${hash} → ${res.status}`)
    return true
  }

  /**
   * Batch existence probe — one `POST /v1/cache/batch` per chunk of up to
   * BATCH_CHUNK hashes, collapsing N per-hash HEADs into a single round-trip.
   * Returns the subset present remotely. Returns `null` when the serve is too
   * old to host the route (404/405) so the caller falls back to the per-hash
   * path; the "unsupported" verdict is remembered for the client's lifetime so
   * a legacy serve costs at most one probe. Throws on any other error (the
   * layered cache degrades the throw to "no batch info").
   */
  async hasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    if (this.batchUnsupported) return null
    const unique = [...new Set(hashes)]
    const present = new Set<string>()
    for (let i = 0; i < unique.length; i += BATCH_CHUNK) {
      const chunk = unique.slice(i, i + BATCH_CHUNK)
      const bytes = new TextEncoder().encode(JSON.stringify({ hashes: chunk }))
      const res = await this.request('POST', this.batchUrl(), {
        body: bytes,
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes.byteLength),
        },
      })
      if (res.status === 404 || res.status === 405) {
        this.batchUnsupported = true
        return null
      }
      if (!res.ok) throw new Error(`POST /v1/cache/batch → ${res.status}`)
      const data = (await res.json()) as { present?: unknown }
      if (!Array.isArray(data.present)) {
        throw new Error('POST /v1/cache/batch → response missing present[]')
      }
      for (const h of data.present) if (typeof h === 'string') present.add(h)
    }
    return present
  }

  async put(
    hash: string,
    body: ArrayBuffer | Uint8Array,
    meta: { durationMs: number },
  ): Promise<void> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
    const res = await this.request('PUT', this.artifactUrl(hash), {
      body,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'x-vx-duration-ms': String(meta.durationMs),
        'x-vx-digest': xxh3Digest(bytes),
      },
    })
    // 409 = the hash already exists (immutable store) — the bytes for a
    // content-addressed key are equal by construction, so this is success.
    if (!res.ok && res.status !== 409) throw new Error(`PUT ${hash} → ${res.status}`)
  }

  private artifactUrl(hash: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/v1/cache/${encodeURIComponent(hash)}`
  }

  private batchUrl(): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/v1/cache/batch`
  }

  private async request(
    method: string,
    url: string,
    init?: {
      body?: ArrayBuffer | Uint8Array
      headers?: Record<string, string>
      /** GET may be answered `307 Location: <pre-signed blob URL>` (the
       *  offload seam) — follow exactly ONE redirect, dropping the bearer
       *  AND the cache-scope header when the target origin differs (a
       *  query-signed URL rejects a request that ALSO carries an
       *  Authorization header; the scope header is serve-facing identity
       *  a blob origin has no business seeing). */
      followOneRedirect?: boolean
    },
  ): Promise<Response> {
    const first = await this.fetchOnce(method, url, {
      auth: true,
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    })
    if (init?.followOneRedirect !== true) return first
    if (first.status !== 307 && first.status !== 302) return first
    const location = first.headers.get('location')
    if (location === null || location === '') {
      throw new Error(`${method} ${url} → ${first.status} with no Location`)
    }
    const target = new URL(location, url)
    const sameOrigin = target.origin === new URL(url).origin
    return await this.fetchOnce(method, target.toString(), { auth: sameOrigin })
  }

  private async fetchOnce(
    method: string,
    url: string,
    init: {
      auth: boolean
      body?: ArrayBuffer | Uint8Array
      headers?: Record<string, string>
    },
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? 60_000
    // Clearable timer, NOT AbortSignal.timeout — its internal timer is not
    // unref'd and would keep the CLI alive after the request resolved.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, {
        method,
        // Redirects are handled manually (one hop, auth-dropping) — never
        // auto-followed with the bearer riding along.
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          ...(init.auth && this.config.token !== undefined
            ? { authorization: `Bearer ${this.config.token}` }
            : {}),
          // Serve-facing identity, gated like the bearer: a cross-origin
          // redirect target (a pre-signed blob URL) must see neither.
          ...(init.auth && this.config.cacheScope !== undefined
            ? { 'x-vx-cache-scope': this.config.cacheScope }
            : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new Error(`${method} ${url} timed out after ${timeoutMs}ms`)
      }
      throw new Error(`${method} ${url} failed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseIntHeader(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
