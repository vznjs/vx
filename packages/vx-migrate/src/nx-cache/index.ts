// @vzn/vx-migrate (nxCache) — a vx `cache` plugin that stores artifacts in any server
// implementing Nx's self-hosted remote cache OpenAPI spec: `GET` and `PUT`
// `/v1/cache/{hash}`, a Bearer token, `application/octet-stream` bodies,
// and an IMMUTABLE record — a second write of an existing hash is `409`.
// The wire is Nx's; the bytes are vx's own artifacts under vx's own keys,
// so the server is storage — an Nx binary cannot read them.
//
// Nothing is on by default: declare `nxCache()` in `vx.workspace.ts` (the
// local store is the floor beneath it) and give it a server (options, or Nx's own
// environment variables so a self-hosted setup carries over). Without one
// the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import {
  definePlugin,
  LayeredCache,
  type CacheLayer,
  type RemoteCacheLayer,
  type VxPlugin,
} from '@vzn/vx'
import { deadlineNamed } from '../remote-deadline.js'
import { headerValueFault } from '../remote-token.js'

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
  // The URL is printed in every refusal line, so a `user:pass@` in it would
  // leak to the log. Credentials go in the access token.
  if (URL.canParse(server)) {
    const u = new URL(server)
    if (u.username !== '' || u.password !== '')
      throw new Error(
        'vx/nx-cache: server carries credentials (user:pass@); pass them as the accessToken instead',
      )
  }
  const accessToken = options.accessToken ?? env['NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN']
  const fault = accessToken ? headerValueFault(accessToken) : null
  if (fault !== null)
    throw new Error(
      `vx/nx-cache: the access token holds ${fault}, which no HTTP header can carry — check the secret (it is not printed)`,
    )
  return {
    server,
    ...(accessToken ? { accessToken } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
  }
}

/**
 * The seam implementation over Nx's two endpoints. The spec has no
 * existence probe, so `has` is a GET whose unread response is kept for the
 * `get` that follows it (the prefetch pass asks exactly that way), which
 * makes a probe plus a fetch one transfer instead of two; a probe that no
 * `get` follows has its body cancelled by the next, so it holds no
 * connection. Bodies stream: `get` returns the `fetch` Response and `put`
 * sends the Blob core hands it. `put` treats `409` as success:
 * the record is immutable and content-addressed, so "already there" is the
 * outcome wanted. An auth failure (401/403) throws ONCE — LayeredCache
 * reports it — and then turns the layer off for the rest of the process;
 * the requests already in flight when it lands degrade in silence rather
 * than repeating it.
 */
export class NxRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private last: { hash: string; res: Response } | undefined
  readonly endpoint: string
  constructor(
    private readonly config: NxCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = `${config.server}/v1/cache`
  }

  /**
   * `undefined` = the token was refused and the refusal is ALREADY
   * reported, so the caller degrades to its miss value in silence. Only the
   * first refusal throws, and a run's calls are concurrent: six projects
   * under a bad token printed five identical lines before this (2026-09-20).
   */
  private async request(
    method: 'GET' | 'PUT',
    hash: string,
    body?: Blob,
  ): Promise<Response | undefined> {
    const headers: Record<string, string> = {}
    if (this.config.accessToken) headers['Authorization'] = `Bearer ${this.config.accessToken}`
    if (body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = String(body.size)
    } else {
      // Nx's own client asks for the binary type. A gateway that keys binary
      // media on Accept (AWS API Gateway) base64-encodes a `*/*` response, and
      // every hit read as a corrupt artifact (nx#33092).
      headers['Accept'] = 'application/octet-stream'
    }
    const res = await this.fetchImpl(`${this.config.server}/v1/cache/${hash}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }).catch((err: unknown) => {
      throw deadlineNamed(err, this.config.timeoutMs)
    })
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      throw new Error(
        `HTTP ${res.status}: ${res.status === 401 ? 'missing or invalid token' : 'access forbidden (a read-only token cannot write)'}; remote cache off for this run`,
      )
    }
    return res
  }

  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    const res = await this.take(hash)
    // The Nx wire carries no producing-task duration.
    return res === null ? null : { body: res, durationMs: undefined }
  }

  private async take(hash: string): Promise<Response | null> {
    if (this.disabled) return null
    if (this.last?.hash === hash) {
      const { res } = this.last
      this.last = undefined
      return res
    }
    const res = await this.request('GET', hash)
    if (res === undefined) return null
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return res
  }

  async has(hash: string): Promise<boolean> {
    const res = await this.take(hash)
    if (res === null) return false
    await this.last?.res.body?.cancel()
    this.last = { hash, res }
    return true
  }

  // Nx's record carries no duration; the seam's `meta` is accepted and unused.
  async put(hash: string, body: Blob, _meta: { durationMs: number }): Promise<void> {
    if (this.disabled) return
    const res = await this.request('PUT', hash, body)
    if (res === undefined) return
    if (res.status === 200 || res.status === 202 || res.status === 409) return
    throw new Error(`HTTP ${res.status}`)
  }
}

/**
 * Declare in `vx.workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [nxCache({ server: 'https://cache.example.com', accessToken: process.env.CACHE_TOKEN })]
 * ```
 *
 * Declines without a server, so it is safe to leave declared.
 */
export function nxCache(options: NxCacheOptions = {}): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx): CacheLayer | undefined {
      const config = resolveNxCacheConfig(options)
      if (config === undefined) return undefined
      return new LayeredCache(ctx.localCache, new NxRemoteCache(config), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`vx/nx-cache: ${err.message}`),
      })
    },
  })
}
