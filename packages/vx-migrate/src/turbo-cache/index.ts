// @vzn/vx-migrate (turboCache) — a vx `cache` plugin that stores artifacts in any
// server speaking Turborepo's remote cache API (`/v8/artifacts`): Vercel's
// hosted cache, or a self-hosted implementation of the published OpenAPI
// spec. The wire is Turbo's; the bytes are vx's own artifacts under vx's
// own keys, so the server is storage — a Turbo binary cannot read them.
//
// Nothing is on by default: declare `turboCache()` in `vx.workspace.ts`
// (the local store is the floor beneath it) and give it a URL and a token (options, or
// Turbo's own environment variables so a self-hosted setup carries over).
// With neither the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import { createHmac, randomUUID, timingSafeEqual, type Hmac } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  definePlugin,
  LayeredCache,
  type CacheLayer,
  type RemoteCacheLayer,
  type VxPlugin,
} from '@vzn/vx'

export interface TurboCacheOptions {
  /** Base URL of the cache server (`https://cache.example.com`), or `TURBO_API`; with a token and neither, Vercel's hosted cache, as for `turbo`. */
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

function updateLength(mac: Hmac, byteLength: number): void {
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(byteLength))
  mac.update(len)
}

/**
 * `x-artifact-tag`: base64(HMAC-SHA256(key, fields)) where every field is
 * prefixed with its byte length as a little-endian u64 — prefix, hash,
 * team id, body — exactly as Turbo generates and verifies it. The body is
 * read as a stream, so a file-backed Blob is signed without being held.
 */
export async function artifactTag(
  key: Uint8Array,
  hash: string,
  teamId: string,
  body: Blob,
): Promise<string> {
  const mac = createHmac('sha256', key)
  for (const field of [
    Buffer.from(SIGNATURE_MESSAGE_PREFIX),
    Buffer.from(hash),
    Buffer.from(teamId),
  ]) {
    updateLength(mac, field.byteLength)
    mac.update(field)
  }
  updateLength(mac, body.size)
  for await (const chunk of body.stream()) mac.update(chunk)
  return mac.digest('base64')
}

/** The verified temp as a body that deletes the temp once read to the end or cancelled. */
function unlinkingStream(file: string): ReadableStream<Uint8Array> {
  const reader = Bun.file(file).stream().getReader()
  const remove = () => unlink(file).catch(() => undefined)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await remove()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (err) {
        await remove()
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await remove()
    },
  })
}

function tagsEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'base64')
  const b = Buffer.from(actual, 'base64')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** Where `turbo` itself sends a token with no `apiUrl`: Vercel's hosted Remote Cache. */
export const VERCEL_API = 'https://vercel.com/api'

/** Resolve options over Turbo's environment; `undefined` = not configured. */
export function resolveTurboCacheConfig(
  options: TurboCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): TurboCacheConfig | undefined {
  const token = options.token ?? env['TURBO_TOKEN']
  // Turbo's own default when a token is set and no `apiUrl` is: Vercel's
  // hosted Remote Cache. A token alone is a configured cache, as it is for
  // `turbo`; no token at all is the declined, local run.
  const apiUrl = (options.apiUrl ?? env['TURBO_API'] ?? (token ? VERCEL_API : undefined))?.replace(
    /\/+$/,
    '',
  )
  if (!apiUrl || !token) return undefined
  // The URL is printed in every refusal line, so a `user:pass@` in it would
  // leak to the log. Credentials go in the token.
  if (URL.canParse(apiUrl)) {
    const u = new URL(apiUrl)
    if (u.username !== '' || u.password !== '')
      throw new Error(
        'vx/turbo-cache: apiUrl carries credentials (user:pass@); pass them as the token instead',
      )
  }
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
 * line, not one per task — the requests already in flight when it lands
 * degrade in silence rather than repeating it.
 *
 * Bodies stream both ways: `put` sends the Blob core hands it, `get`
 * returns the `fetch` Response. With a signature key the tag must verify
 * before core sees a byte, so a signed download lands in a temp under
 * `tempDir` first and is handed over only once it has.
 */
export class TurboRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private readonly key: Uint8Array | undefined
  constructor(
    private readonly config: TurboCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tempDir: string = tmpdir(),
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

  /**
   * `undefined` = the token was refused and the refusal is ALREADY
   * reported, so the caller degrades to its miss value in silence. Only the
   * first refusal throws, and a run's calls are concurrent: six projects
   * under a bad token printed five identical lines before this (2026-09-20).
   */
  private async request(
    method: string,
    pathname: string,
    init: { body?: Blob | string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response | undefined> {
    const res = await this.fetchImpl(this.url(pathname), {
      method,
      headers: this.headers(init.headers),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? this.config.timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      throw new Error(
        `${method} ${this.config.apiUrl}/v8/artifacts → ${res.status}: the token was refused; remote cache off for this run`,
      )
    }
    return res
  }

  async has(hash: string): Promise<boolean> {
    if (this.disabled) return false
    const res = await this.request('HEAD', `/${hash}`)
    if (res === undefined) return false
    if (res.status === 200) return true
    if (res.status === 404) return false
    throw new Error(`HEAD ${hash} → ${res.status}`)
  }

  async hasMany(hashes: readonly string[]): Promise<Set<string> | null> {
    if (this.disabled || hashes.length === 0) return this.disabled ? new Set() : null
    const res = await this.request('POST', '', {
      body: JSON.stringify({ hashes }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (res === undefined) return new Set()
    if (res.status !== 200) return null
    const info = (await res.json()) as Record<string, unknown>
    return new Set(hashes.filter((h) => info[h] !== null && info[h] !== undefined))
  }

  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    if (this.disabled) return null
    // A gateway that keys binary media on Accept base64-encodes a `*/*`
    // response, and every hit read as a corrupt artifact (nx#33092's class).
    const res = await this.request('GET', `/${hash}`, {
      headers: { Accept: 'application/octet-stream' },
    })
    if (res === undefined) return null
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`GET ${hash} → ${res.status}`)
    const duration = Number(res.headers.get('x-artifact-duration'))
    const durationMs = Number.isFinite(duration) && duration > 0 ? duration : undefined
    if (this.key === undefined) return { body: res, durationMs }
    return { body: await this.verified(this.key, hash, res), durationMs }
  }

  /**
   * The tag's message carries the body's length BEFORE its bytes, and a
   * chunked response declares no length, so the body is written to the temp
   * first and signed from there: two passes over a file, never one in memory.
   */
  private async verified(key: Uint8Array, hash: string, res: Response): Promise<Response> {
    const refused = () =>
      new Error(`GET ${hash}: artifact signature did not verify — treated as a miss`)
    const tag = res.headers.get('x-artifact-tag')
    if (tag === null) {
      await res.body?.cancel()
      throw refused()
    }
    const temp = path.join(this.tempDir, `vx-turbo-${hash}-${randomUUID()}`)
    try {
      await Bun.write(temp, res)
      const expected = await artifactTag(key, hash, this.config.teamId ?? '', Bun.file(temp))
      if (!tagsEqual(expected, tag)) throw refused()
    } catch (err) {
      await unlink(temp).catch(() => undefined)
      throw err
    }
    return new Response(unlinkingStream(temp))
  }

  async put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void> {
    if (this.disabled) return
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.size),
      'x-artifact-duration': String(Math.max(0, Math.round(meta.durationMs))),
    }
    if (this.key !== undefined) {
      headers['x-artifact-tag'] = await artifactTag(this.key, hash, this.config.teamId ?? '', body)
    }
    const res = await this.request('PUT', `/${hash}`, {
      body,
      headers,
      timeoutMs: this.config.uploadTimeoutMs,
    })
    if (res === undefined) return
    if (res.status !== 200 && res.status !== 202) throw new Error(`PUT ${hash} → ${res.status}`)
  }
}

/**
 * Declare in `vx.workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [turboCache({ apiUrl: 'https://cache.example.com', token: process.env.CACHE_TOKEN })]
 * ```
 *
 * Declines without a URL and a token, so it is safe to leave declared.
 */
export function turboCache(options: TurboCacheOptions = {}): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx): CacheLayer | undefined {
      const config = resolveTurboCacheConfig(options)
      if (config === undefined) return undefined
      return new LayeredCache(ctx.localCache, new TurboRemoteCache(config), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`vx/turbo-cache: ${err.message}`),
      })
    },
  })
}
