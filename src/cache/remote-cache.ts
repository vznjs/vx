// Remote cache HTTP client — speaks the Turborepo /v8/artifacts/ spec.
//
// Wire-level only. Knows nothing about local storage, tar formats, or how
// the orchestrator uses the cache; those concerns live in the LayeredCache
// + the pack/unpack module (separate PR).
//
// Endpoint shape (from docs/design/remote-cache.md):
//   HEAD /v8/artifacts/<hash>?teamId=&slug=
//   GET  /v8/artifacts/<hash>?teamId=&slug=
//   PUT  /v8/artifacts/<hash>?teamId=&slug=
//   POST /v8/artifacts (batch existence)
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
  /** Optional HMAC tag for payload signing (x-artifact-tag). */
  tag?: string
  /** Optional CI name (x-artifact-client-ci). */
  ci?: string
  /** Optional interactive flag (x-artifact-client-interactive: "1"). */
  interactive?: boolean
}

export interface RemoteGetResult {
  body: ArrayBuffer
  durationMs: number | undefined
  tag: string | undefined
}

export interface RemoteBatchInfo {
  size: number
  taskDurationMs: number | undefined
  tag: string | undefined
}

export class RemoteCache {
  constructor(private readonly config: RemoteCacheConfig) {}

  async has(hash: string): Promise<boolean> {
    const res = await this.fetch('HEAD', this.artifactUrl(hash))
    if (res.status === 404) return false
    if (!res.ok) throw new RemoteCacheError(`HEAD ${hash} → ${res.status}`, res.status)
    return true
  }

  async get(hash: string): Promise<RemoteGetResult | null> {
    const res = await this.fetch('GET', this.artifactUrl(hash))
    if (res.status === 404) return null
    if (!res.ok) throw new RemoteCacheError(`GET ${hash} → ${res.status}`, res.status)
    const body = await res.arrayBuffer()
    return {
      body,
      durationMs: parseIntHeader(res.headers.get('x-artifact-duration')),
      tag: res.headers.get('x-artifact-tag') ?? undefined,
    }
  }

  async put(hash: string, body: ArrayBuffer | Uint8Array, meta: RemotePutMetadata): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'x-artifact-duration': String(meta.durationMs),
    }
    if (meta.tag !== undefined) headers['x-artifact-tag'] = meta.tag
    if (meta.ci !== undefined) headers['x-artifact-client-ci'] = meta.ci
    if (meta.interactive) headers['x-artifact-client-interactive'] = '1'

    const res = await this.fetch('PUT', this.artifactUrl(hash), { body, headers })
    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new RemoteCacheError(`PUT ${hash} → ${res.status}`, res.status)
    }
  }

  async batchExistence(hashes: readonly string[]): Promise<Record<string, RemoteBatchInfo>> {
    if (hashes.length === 0) return {}
    const url = this.urlWithTenancy(`${this.config.baseUrl}/v8/artifacts`)
    const res = await this.fetch('POST', url, {
      body: JSON.stringify({ hashes }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new RemoteCacheError(`POST /v8/artifacts → ${res.status}`, res.status)
    const json = (await res.json()) as Record<
      string,
      { size: number; taskDurationMs?: number; tag?: string }
    >
    const out: Record<string, RemoteBatchInfo> = {}
    for (const [hash, info] of Object.entries(json)) {
      out[hash] = {
        size: info.size,
        taskDurationMs: info.taskDurationMs,
        tag: info.tag,
      }
    }
    return out
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
