// @vzn/vx-nx-cache — a vx `cache` plugin that stores artifacts in any server
// implementing Nx's self-hosted remote cache OpenAPI spec: `GET` and `PUT`
// `/v1/cache/{hash}`, a Bearer token, `application/octet-stream` bodies,
// and an IMMUTABLE record — a second write of an existing hash is `409`.
// The wire is Nx's; the bytes are vx's own artifacts under vx's own keys,
// so the server is storage — an Nx binary cannot read them.
//
// Nothing is on by default: declare `nxCache()` in `vx.workspace.ts`,
// before `localCachePlugin()`, and give it a server (options, or Nx's own
// environment variables so a self-hosted setup carries over). Without one
// the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import { LayeredCache, type CacheLayer, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

export const NX_CACHE_PLUGIN = 'vx/nx-cache'

export interface NxCacheOptions {
  /** Base URL of the cache server, or `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`. */
  server?: string
  /** Bearer token, or `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. Optional: a server may run open. */
  accessToken?: string
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number
}

export interface NxCacheConfig {
  server: string
  accessToken?: string
  timeoutMs: number
}

/** Resolve options over Nx's environment; `undefined` = not configured. */
export function resolveNxCacheConfig(
  options: NxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): NxCacheConfig | undefined {
  const server = (options.server ?? env['NX_SELF_HOSTED_REMOTE_CACHE_SERVER'])?.replace(/\/+$/, '')
  if (!server) return undefined
  const accessToken = options.accessToken ?? env['NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN']
  return {
    server,
    ...(accessToken ? { accessToken } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
  }
}

/**
 * The seam implementation over Nx's two endpoints. The spec has no
 * existence probe, so `has` is a GET whose body is kept for the `get` that
 * follows it (the prefetch pass asks exactly that way), which makes a probe
 * plus a fetch one transfer instead of two. `put` treats `409` as success:
 * the record is immutable and content-addressed, so "already there" is the
 * outcome wanted. An auth failure (401/403) throws ONCE — LayeredCache
 * reports it — and then turns the layer off for the rest of the process.
 */
export class NxRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private last: { hash: string; body: ArrayBuffer } | undefined
  constructor(
    private readonly config: NxCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: 'GET' | 'PUT', hash: string, body?: Uint8Array): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.config.accessToken) headers['Authorization'] = `Bearer ${this.config.accessToken}`
    if (body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = String(body.byteLength)
    }
    const res = await this.fetchImpl(`${this.config.server}/v1/cache/${hash}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      this.disabled = true
      throw new Error(
        `${method} ${this.config.server}/v1/cache → ${res.status}: ${res.status === 401 ? 'missing or invalid token' : 'access forbidden (a read-only token cannot write)'}; remote cache off for this run`,
      )
    }
    return res
  }

  async get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null> {
    if (this.disabled) return null
    if (this.last?.hash === hash) {
      const { body } = this.last
      this.last = undefined
      return { body, durationMs: undefined }
    }
    const res = await this.request('GET', hash)
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`GET ${hash} → ${res.status}`)
    // The Nx wire carries no producing-task duration.
    return { body: await res.arrayBuffer(), durationMs: undefined }
  }

  async has(hash: string): Promise<boolean> {
    const got = await this.get(hash)
    if (got === null) return false
    this.last = { hash, body: got.body }
    return true
  }

  async put(hash: string, body: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.disabled) return
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
    const res = await this.request('PUT', hash, bytes)
    if (res.status === 200 || res.status === 202 || res.status === 409) return
    throw new Error(`PUT ${hash} → ${res.status}`)
  }
}

/**
 * Declare in `vx.workspace.ts`, BEFORE `localCachePlugin()`:
 *
 * ```ts
 * plugins: [nxCache({ server: 'https://cache.example.com', accessToken: process.env.CACHE_TOKEN }), localExecutorPlugin(), localCachePlugin()]
 * ```
 *
 * Declines without a server, so it is safe to leave declared.
 */
export function nxCache(options: NxCacheOptions = {}): VxPlugin {
  return {
    name: NX_CACHE_PLUGIN,
    cache(ctx): CacheLayer | undefined {
      const config = resolveNxCacheConfig(options)
      if (config === undefined) return undefined
      return new LayeredCache(ctx.localCache, new NxRemoteCache(config), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`vx/nx-cache: ${err.message}`),
      })
    },
  }
}
