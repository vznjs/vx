// Remote cache HTTP client — speaks the Turborepo /v8/artifacts/ spec.
//
// Wire-level only. Knows nothing about local storage, tar formats, or
// how the orchestrator uses the cache; those concerns live in the
// LayeredCache. Two operations only — GET (read) and PUT (write).
//
// Reference servers we want to interop with at the HTTP layer:
//   ducktors/turborepo-remote-cache, Fox32/openturbo-remote-cache,
//   Vercel hosted cache.

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
}

export interface RemotePutMetadata {
  /** Task duration in ms. Sent as x-artifact-duration. */
  durationMs: number
}

export interface RemoteGetResult {
  body: ArrayBuffer
  durationMs: number | undefined
}

export class RemoteCache {
  constructor(private readonly config: RemoteCacheConfig) {}

  async get(hash: string): Promise<RemoteGetResult | null> {
    const res = await this.fetch('GET', this.artifactUrl(hash))
    if (res.status === 404) return null
    if (!res.ok) throw new RemoteCacheError(`GET ${hash} → ${res.status}`, res.status)
    // A body that ends before the declared content-length (server died
    // mid-transfer) throws from arrayBuffer(), not from fetch() — wrap
    // it here so callers see a typed RemoteCacheError and the layered
    // cache can degrade it to a miss. (fetch already enforces the
    // content-length contract: short bodies throw, long bodies are
    // truncated to the declared length, so no manual byte check.)
    let body: ArrayBuffer
    try {
      body = await res.arrayBuffer()
    } catch (err) {
      throw new RemoteCacheError(
        `GET ${hash} → body read failed: ${(err as Error).message}`,
        res.status,
        err,
      )
    }
    return {
      body,
      durationMs: parseIntHeader(res.headers.get('x-artifact-duration')),
    }
  }

  async put(hash: string, body: ArrayBuffer | Uint8Array, meta: RemotePutMetadata): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'x-artifact-duration': String(meta.durationMs),
    }

    const res = await this.fetch('PUT', this.artifactUrl(hash), { body, headers })
    // Any 2xx is success — Turbo-compatible servers answer 200/201/202.
    if (!res.ok) {
      throw new RemoteCacheError(`PUT ${hash} → ${res.status}`, res.status)
    }
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
    init?: { body?: ArrayBuffer | Uint8Array | string; headers?: Record<string, string> },
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? 60_000
    try {
      return await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${this.config.token}`,
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
