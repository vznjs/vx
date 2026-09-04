// @vzn/vx-turbo-cache — a vx `cache` plugin that stores artifacts in any
// server speaking Turborepo's remote cache API (`/v8/artifacts`): Vercel's
// hosted cache, or a self-hosted implementation of the published OpenAPI
// spec. The wire is Turbo's; the bytes are vx's own artifacts under vx's
// own keys, so the server is storage — a Turbo binary cannot read them.
//
// Nothing is on by default: declare `turboCache()` in `vx.workspace.ts`,
// before `localCachePlugin()`, and give it a URL and a token (options, or
// Turbo's own environment variables so a self-hosted setup carries over).
// With neither the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { LayeredCache, type CacheLayer, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

export const TURBO_CACHE_PLUGIN = 'vx/turbo-cache'

export interface TurboCacheOptions {
  /** Base URL of the cache server (`https://cache.example.com`), or `TURBO_API`. */
  apiUrl?: string
  /** Bearer token every request carries, or `TURBO_TOKEN`. */
  token?: string
  /** `teamId` query parameter, or `TURBO_TEAMID`. Required with `signatureKey`. */
  teamId?: string
  /** `slug` query parameter (a team slug), or `TURBO_TEAM`. */
  teamSlug?: string
  /**
   * Sign uploads and verify downloads with Turbo's artifact signature
   * (HMAC-SHA256, `x-artifact-tag`), or `TURBO_REMOTE_CACHE_SIGNATURE_KEY`.
   * At least 32 bytes, used raw. A download whose tag does not verify is a
   * miss, never a restore.
   */
  signatureKey?: string
  /** Per-request deadline for HEAD/GET/POST (default 30 s) … */
  timeoutMs?: number
  /** … and for PUT (default 60 s), Turbo's own defaults. */
  uploadTimeoutMs?: number
}

export interface TurboCacheConfig {
  apiUrl: string
  token: string
  teamId?: string
  teamSlug?: string
  signatureKey?: string
  timeoutMs: number
  uploadTimeoutMs: number
}

/** Turbo's signature message prefix (`crates/turborepo-cache/src/signature_authentication.rs`). */
const SIGNATURE_MESSAGE_PREFIX = 'artifact-signature:v2'
export const MIN_SIGNATURE_KEY_LENGTH = 32

/**
 * `x-artifact-tag`: base64(HMAC-SHA256(key, fields)) where every field is
 * prefixed with its byte length as a little-endian u64 — prefix, hash,
 * team id, body — exactly as Turbo generates and verifies it.
 */
export function artifactTag(
  key: Uint8Array,
  hash: string,
  teamId: string,
  body: Uint8Array,
): string {
  const mac = createHmac('sha256', key)
  for (const field of [
    Buffer.from(SIGNATURE_MESSAGE_PREFIX),
    Buffer.from(hash),
    Buffer.from(teamId),
    body,
  ]) {
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(field.byteLength))
    mac.update(len)
    mac.update(field)
  }
  return mac.digest('base64')
}

function tagsEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'base64')
  const b = Buffer.from(actual, 'base64')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** Resolve options over Turbo's environment; `undefined` = not configured. */
export function resolveTurboCacheConfig(
  options: TurboCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): TurboCacheConfig | undefined {
  const apiUrl = (options.apiUrl ?? env['TURBO_API'])?.replace(/\/+$/, '')
  const token = options.token ?? env['TURBO_TOKEN']
  if (!apiUrl || !token) return undefined
  const teamId = options.teamId ?? env['TURBO_TEAMID']
  const teamSlug = options.teamSlug ?? env['TURBO_TEAM']
  const signatureKey = options.signatureKey ?? env['TURBO_REMOTE_CACHE_SIGNATURE_KEY']
  if (signatureKey !== undefined) {
    if (Buffer.byteLength(signatureKey) < MIN_SIGNATURE_KEY_LENGTH) {
      throw new Error(
        `vx/turbo-cache: signatureKey must be at least ${MIN_SIGNATURE_KEY_LENGTH} bytes (Turbo's minimum)`,
      )
    }
    if (!teamId)
      throw new Error(
        'vx/turbo-cache: signatureKey needs teamId — the team id is part of the signed message',
      )
  }
  return {
    apiUrl,
    token,
    ...(teamId ? { teamId } : {}),
    ...(teamSlug ? { teamSlug } : {}),
    ...(signatureKey !== undefined ? { signatureKey } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 60_000,
  }
}

/**
 * The seam implementation: `has` is HEAD, `hasMany` is the batch query,
 * `get`/`put` carry `x-artifact-duration` (and the tag when signing). An
 * auth failure (401/403) throws ONCE — LayeredCache reports it — and then
 * turns the layer off for the rest of the process, so a bad token costs one
 * line, not one per task.
 */
export class TurboRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private readonly key: Uint8Array | undefined
  constructor(
    private readonly config: TurboCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = config.signatureKey === undefined ? undefined : Buffer.from(config.signatureKey)
  }

  private url(pathname: string): string {
    const u = new URL(`${this.config.apiUrl}/v8/artifacts${pathname}`)
    if (this.config.teamId) u.searchParams.set('teamId', this.config.teamId)
    if (this.config.teamSlug) u.searchParams.set('slug', this.config.teamSlug)
    return u.toString()
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'x-artifact-client-interactive': process.stdout.isTTY ? '1' : '0',
      ...extra,
    }
  }

  private async request(
    method: string,
    pathname: string,
    init: { body?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const res = await this.fetchImpl(this.url(pathname), {
      method,
      headers: this.headers(init.headers),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? this.config.timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      this.disabled = true
      throw new Error(
        `${method} ${this.config.apiUrl}/v8/artifacts → ${res.status}: the token was refused; remote cache off for this run`,
      )
    }
    return res
  }

  async has(hash: string): Promise<boolean> {
    if (this.disabled) return false
    const res = await this.request('HEAD', `/${hash}`)
    if (res.status === 200) return true
    if (res.status === 404) return false
    throw new Error(`HEAD ${hash} → ${res.status}`)
  }

  async hasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    if (this.disabled || hashes.length === 0) return this.disabled ? new Set() : null
    const res = await this.request('POST', '', {
      body: Buffer.from(JSON.stringify({ hashes })),
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.status !== 200) return null
    const info = (await res.json()) as Record<string, unknown>
    return new Set(hashes.filter((h) => info[h] !== null && info[h] !== undefined))
  }

  async get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null> {
    if (this.disabled) return null
    const res = await this.request('GET', `/${hash}`)
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`GET ${hash} → ${res.status}`)
    const body = await res.arrayBuffer()
    if (this.key !== undefined) {
      const tag = res.headers.get('x-artifact-tag')
      const expected = artifactTag(this.key, hash, this.config.teamId ?? '', new Uint8Array(body))
      if (tag === null || !tagsEqual(expected, tag)) {
        throw new Error(`GET ${hash}: artifact signature did not verify — treated as a miss`)
      }
    }
    const duration = Number(res.headers.get('x-artifact-duration'))
    return { body, durationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined }
  }

  async put(
    hash: string,
    body: ArrayBuffer | Uint8Array,
    meta: { durationMs: number },
  ): Promise<void> {
    if (this.disabled) return
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'x-artifact-duration': String(Math.max(0, Math.round(meta.durationMs))),
    }
    if (this.key !== undefined) {
      headers['x-artifact-tag'] = artifactTag(this.key, hash, this.config.teamId ?? '', bytes)
    }
    const res = await this.request('PUT', `/${hash}`, {
      body: bytes,
      headers,
      timeoutMs: this.config.uploadTimeoutMs,
    })
    if (res.status !== 200 && res.status !== 202) throw new Error(`PUT ${hash} → ${res.status}`)
  }
}

/**
 * Declare in `vx.workspace.ts`, BEFORE `localCachePlugin()`:
 *
 * ```ts
 * plugins: [turboCache({ apiUrl: 'https://cache.example.com', token: process.env.CACHE_TOKEN }), localExecutorPlugin(), localCachePlugin()]
 * ```
 *
 * Declines without a URL and a token, so it is safe to leave declared.
 */
export function turboCache(options: TurboCacheOptions = {}): VxPlugin {
  return {
    name: TURBO_CACHE_PLUGIN,
    cache(ctx): CacheLayer | undefined {
      const config = resolveTurboCacheConfig(options)
      if (config === undefined) return undefined
      return new LayeredCache(ctx.localCache, new TurboRemoteCache(config), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`vx/turbo-cache: ${err.message}`),
      })
    },
  }
}
