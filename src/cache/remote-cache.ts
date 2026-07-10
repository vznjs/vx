// Remote cache HTTP client — speaks the Turborepo /v8/artifacts/ spec.
//
// Wire-level only. Knows nothing about local storage, tar formats, or
// how the orchestrator uses the cache; those concerns live in the
// LayeredCache. Three operations — GET (read), PUT (write), and HEAD
// (existence probe for the plan path).
//
// Reference servers we want to interop with at the HTTP layer:
//   ducktors/turborepo-remote-cache, Fox32/openturbo-remote-cache,
//   Vercel hosted cache.

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface RemoteCacheConfig {
  /** Base URL of the cache server, e.g. https://cache.example.com */
  baseUrl: string
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token: string
  /** Optional Turbo-style tenant identifiers; sent as ?teamId=&slug=. */
  teamId?: string
  slug?: string
  /** Per-request timeout in ms. Default 60_000. */
  timeoutMs?: number
  /**
   * HMAC artifact-signing key (Turbo's `remoteCache.signature` scheme).
   * When set, every PUT carries an `x-artifact-tag` over the artifact
   * and every GET response must carry a matching tag — a missing or
   * mismatched tag is a `RemoteCacheError`, never a silent accept.
   */
  signatureKey?: string
  /**
   * Untrusted per-PR partition id, sent as `x-vx-cache-scope`. A compatible
   * remote-cache server MAY partition untrusted writes by this id so one fork
   * PR can't read or poison another's cache. Ignored by trusted writes and by
   * third-party Turbo servers.
   */
  cacheScope?: string
  /**
   * Turbo's `--preflight` mechanism (pre-signed URL support): when set, every
   * artifact request is preceded by an `OPTIONS` preflight; the response's
   * `Location` (absolute or relative) becomes the real request URL — typically
   * a pre-signed blob-store URL — and `Access-Control-Allow-Headers` decides
   * whether the bearer rides along (kept iff `*` or it names `authorization`;
   * a query-signed S3/R2 URL rejects a request that ALSO carries an
   * Authorization header). A server without the mechanism answers with no
   * Location and the request proceeds unchanged. Off by default — an extra
   * round-trip per artifact buys nothing against a direct-serving server.
   * See docs/design/presigned-artifacts-2026-07.md.
   */
  preflight?: boolean
}

export interface RemotePutMetadata {
  /** Task duration in ms. Sent as x-artifact-duration. */
  durationMs: number
}

export interface RemoteGetResult {
  body: ArrayBuffer
  durationMs: number | undefined
}

/**
 * Hard cap on a downloaded artifact body (compressed bytes). A malicious or
 * compromised remote (or a MITM answering a GET) must not be able to stream an
 * unbounded body into `res.arrayBuffer()` and exhaust the victim's memory —
 * the download aborts past this and degrades to a cache miss. Mirrors the
 * server-side PUT cap.
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

/** Where to send the real request, and whether the bearer rides along. */
interface ResolvedTarget {
  url: string
  auth: boolean
}

export class RemoteCache {
  constructor(private readonly config: RemoteCacheConfig) {}

  async get(hash: string): Promise<RemoteGetResult | null> {
    const target = await this.resolveTarget('GET', this.artifactUrl(hash), ['authorization'])
    const res = await this.fetch('GET', target.url, { auth: target.auth })
    if (res.status === 404) return null
    if (!res.ok) throw new RemoteCacheError(`GET ${hash} → ${res.status}`, res.status)
    // Refuse an honestly-declared oversize body before reading a byte.
    const declaredLen = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLen) && declaredLen > MAX_REMOTE_ARTIFACT_BYTES) {
      throw new RemoteCacheError(
        `GET ${hash} → artifact too large (${declaredLen} bytes > ${MAX_REMOTE_ARTIFACT_BYTES} cap)`,
        res.status,
      )
    }
    // A body that ends before the declared content-length (server died
    // mid-transfer) throws from the reader, not from fetch() — wrap it here
    // so callers see a typed RemoteCacheError and the layered cache can
    // degrade it to a miss. The bounded read also aborts a body that lies
    // about (or omits) its length once it crosses the cap.
    let body: ArrayBuffer
    try {
      body = await readBodyBounded(res, MAX_REMOTE_ARTIFACT_BYTES)
    } catch (err) {
      throw new RemoteCacheError(
        `GET ${hash} → body read failed: ${(err as Error).message}`,
        res.status,
        err,
      )
    }
    if (this.config.signatureKey !== undefined) {
      const received = res.headers.get('x-artifact-tag')
      if (received === null) {
        // A signing deployment must not silently accept unsigned
        // artifacts — that would let an attacker strip the tag.
        throw new RemoteCacheError(
          `GET ${hash} → signature verification enabled but response carries no x-artifact-tag`,
          res.status,
        )
      }
      if (!this.tagMatches(hash, new Uint8Array(body), received)) {
        throw new RemoteCacheError(`GET ${hash} → x-artifact-tag signature mismatch`, res.status)
      }
    }
    return {
      body,
      durationMs: parseIntHeader(res.headers.get('x-artifact-duration')),
    }
  }

  /**
   * Existence probe — Turbo wire `HEAD /v8/artifacts/:hash` (200 =
   * exists, 404 = not). No body transfer; the plan path (`--dry` /
   * `--graph`) predicts remote hits with this so it never downloads
   * artifacts. Other failures throw a `RemoteCacheError` like `get`;
   * the LayeredCache degrades them to a miss.
   */
  async has(hash: string): Promise<boolean> {
    // Turbo preflights artifact_exists too (a HEAD may redirect to the blob).
    const target = await this.resolveTarget('HEAD', this.artifactUrl(hash), ['authorization'])
    const res = await this.fetch('HEAD', target.url, { auth: target.auth })
    if (res.status === 404) return false
    if (!res.ok) throw new RemoteCacheError(`HEAD ${hash} → ${res.status}`, res.status)
    return true
  }

  async put(hash: string, body: ArrayBuffer | Uint8Array, meta: RemotePutMetadata): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'x-artifact-duration': String(meta.durationMs),
    }
    if (this.config.signatureKey !== undefined) {
      headers['x-artifact-tag'] = this.artifactTag(
        hash,
        body instanceof Uint8Array ? body : new Uint8Array(body),
      )
    }

    const target = await this.resolveTarget('PUT', this.artifactUrl(hash), [
      'authorization',
      ...Object.keys(headers).map((h) => h.toLowerCase()),
    ])
    const res = await this.fetch('PUT', target.url, { body, headers, auth: target.auth })
    // Any 2xx is success — Turbo-compatible servers answer 200/201/202.
    if (!res.ok) {
      throw new RemoteCacheError(`PUT ${hash} → ${res.status}`, res.status)
    }
  }

  /**
   * The Turbo `--preflight` handshake: `OPTIONS <url>` carrying the intended
   * method + header NAMES (never values) and the bearer; the response's
   * `Location` (absolute or relative to the request URL) is where the real
   * request goes, and the bearer rides only when `Access-Control-Allow-Headers`
   * is `*` or names `authorization`. No Location → the original URL, bearer
   * kept. Disabled (the default) → identity, zero extra requests.
   */
  private async resolveTarget(
    method: string,
    url: string,
    headerNames: string[],
  ): Promise<ResolvedTarget> {
    if (this.config.preflight !== true) return { url, auth: true }
    const res = await this.fetch('OPTIONS', url, {
      headers: {
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': headerNames.join(', '),
      },
    })
    if (!res.ok) {
      throw new RemoteCacheError(`OPTIONS ${url} → ${res.status} (preflight)`, res.status)
    }
    const location = res.headers.get('location')
    if (location === null || location === '') return { url, auth: true }
    const resolved = new URL(location, url).toString()
    const allow = res.headers.get('access-control-allow-headers') ?? ''
    const names = allow.split(',').map((s) => s.trim().toLowerCase())
    const auth = names.includes('*') || names.includes('authorization')
    return { url: resolved, auth }
  }

  // Turbo's construction (crates/turborepo-cache/src/signature_authentication.rs):
  // base64(HMAC-SHA256(key, utf8(hash) || utf8(teamId ?? '') || body)).
  // Byte-compatible with Turbo so signing servers/clients interop.
  private artifactTag(hash: string, body: Uint8Array): string {
    return createHmac('sha256', this.config.signatureKey!)
      .update(hash)
      .update(this.config.teamId ?? '')
      .update(body)
      .digest('base64')
  }

  private tagMatches(hash: string, body: Uint8Array, received: string): boolean {
    const expected = Buffer.from(this.artifactTag(hash, body), 'base64')
    const actual = Buffer.from(received, 'base64')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  private artifactUrl(hash: string): string {
    return this.urlWithTenancy(`${this.config.baseUrl}/v8/artifacts/${encodeURIComponent(hash)}`)
  }

  private urlWithTenancy(base: string): string {
    const params = new URLSearchParams()
    if (this.config.teamId) params.set('teamId', this.config.teamId)
    if (this.config.slug) params.set('slug', this.config.slug)
    const q = params.toString()
    return q ? `${base}?${q}` : base
  }

  private async fetch(
    method: string,
    url: string,
    init?: {
      body?: ArrayBuffer | Uint8Array | string
      headers?: Record<string, string>
      /** False = a preflight said the redirected (query-signed) URL must not
       *  carry the bearer. Default true. */
      auth?: boolean
    },
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? 60_000
    try {
      return await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(init?.auth !== false ? { Authorization: `Bearer ${this.config.token}` } : {}),
          // The untrusted per-PR partition (an optional server-side extension;
          // a third-party Turbo server ignores it). Isolates one fork PR's
          // writes/reads from another's within the untrusted tier.
          ...(this.config.cacheScope !== undefined
            ? { 'x-vx-cache-scope': this.config.cacheScope }
            : {}),
          ...init?.headers,
        },
        ...(init?.body !== undefined ? { body: init.body } : {}),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new RemoteCacheError(`${method} ${url} timed out after ${timeoutMs}ms`, 0, err)
      }
      throw new RemoteCacheError(`${method} ${url} failed: ${(err as Error).message}`, 0, err)
    }
  }
}

export class RemoteCacheError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RemoteCacheError'
  }
}

function parseIntHeader(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
