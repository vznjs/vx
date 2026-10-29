// `vx-cache-server` on Cloudflare Workers: artifacts in R2, nothing else.
// `wrangler.jsonc` deploys it; ALLOW, AUDIENCE and the limits are vars in
// it (README.md § On Cloudflare Workers).

import { type Authorize, errorJson, oidcAuth, parseAllow } from '@vzn/vx-devtools'
import { createCacheServer, DEFAULT_LIMITS, type Limits, limitsFrom } from './server.js'
import type { Blobs } from './store.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
export interface R2Bucket {
  put(name: string, body: ReadableStream<Uint8Array>): Promise<unknown>
  get(name: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>
  head(name: string): Promise<{ size: number } | null>
}
/** The data center's cache (Workers Cache API): free, and per data center. */
interface WorkersCache {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, res: Response): Promise<void>
}
declare const caches: { open(name: string): Promise<WorkersCache> }
export interface Context {
  waitUntil(p: Promise<unknown>): void
}
declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export interface Env {
  readonly BLOBS: R2Bucket
  /** Who may take part (`parseAllow`): `issuer:owner/repo:workflow` entries, space separated. */
  readonly ALLOW?: string
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  /** `public`: a request with no token reads a repository ALLOW names. */
  readonly READ_ACCESS?: string
  /** A string, or a number as wrangler.jsonc may write it. */
  readonly MAX_CHECK_HASHES?: string | number
  readonly MAX_UPLOAD_BYTES?: string | number
}

/** An object's key in the data center's cache. */
const keyOf = (name: string): Request => new Request(`https://vx-cache.blobs/${name}`)

/**
 * R2, read through the data center's cache: an artifact never changes
 * under its name, so a copy needs no expiry of its own. The server has
 * checked the token and named the object before a read reaches here.
 */

export function r2Blobs(bucket: R2Bucket, cache: Promise<WorkersCache>, ctx: Context): Blobs {
  return {
    async put(name, body, size) {
      // R2 takes a stream of known length; this one errors at any other, so
      // R2 never keeps a short body. The runtime holds a request's body to
      // its Content-Length, so a failure here is R2's (or a client gone):
      // it was answered 400, "the body is not N bytes", for a whole body.
      const fixed = new FixedLengthStream(size)
      await Promise.all([bucket.put(name, fixed.readable), body.pipeTo(fixed.writable)])
    },
    get: async (name) => {
      const key = keyOf(name)
      const hit = await (await cache).match(key)
      if (hit?.body) return { body: hit.body, size: Number(hit.headers.get('content-length')) }
      const o = await bucket.get(name)
      if (o === null) return null
      // The copy is R2 read again, never a tee of the client's body: a tee
      // on Workers reads at its slower branch's pace, and the cache write
      // held a download for 19 minutes (main, 2026-10-28).
      ctx.waitUntil(
        (async () => {
          const again = await bucket.get(name)
          if (again === null) return
          const headers = {
            'content-length': String(again.size),
            'cache-control': 'public, max-age=31536000, immutable',
          }
          await (await cache).put(key, new Response(again.body, { headers }))
        })(),
      )
      return { body: o.body, size: o.size }
    },
    // R2 alone answers whether it holds an object: a check, a HEAD and a
    // PUT's skip. The data center's copy outlives R2's (expiry, a wipe), so
    // a writer told "held" there skipped its upload and a reader in another
    // data center found nothing (2026-10-27: a DTE worker's save, then the
    // run's read, a 404).
    size: async (name) => (await bucket.head(name))?.size ?? null,
  }
}

/**
 * A check's lookups by default: a Worker request has 6 calls waiting on R2
 * at once and queues the rest, so a check of 6 answers in one round and a
 * client sends many at once (measured, 2026-10-25: 6 heads 64 ms, 24 341
 * ms, 134 1.1-1.4 s; from a GitHub runner, 134 hashes, half held: 23
 * checks of 6 at once 168-216 ms median, 134 single lookups 246-349 ms,
 * one check of 134 1.9 s). A list is no way round it: a scope may hold
 * billions.
 */
const CHECK_LOOKUPS = 6

/**
 * The limits as set, unclamped: a plan's limits are the operator's to set
 * (2026-10-25: never optimize for the free plan).
 */
function workerLimits(env: Env): Limits {
  return { ...DEFAULT_LIMITS, maxCheckHashes: CHECK_LOOKUPS, ...limitsFrom(env) }
}

/** What a request shares per isolate and settings. */
let made: { key: string; authorize: Authorize; limits: Limits } | undefined

export default {
  async fetch(req: Request, env: Env, ctx: Context): Promise<Response> {
    const key = [
      env.ALLOW,
      env.AUDIENCE,
      env.READ_ACCESS,
      env.MAX_CHECK_HASHES,
      env.MAX_UPLOAD_BYTES,
    ].join('\0')
    if (made?.key !== key) {
      let allow
      let limits
      try {
        allow = parseAllow(env.ALLOW ?? '')
      } catch (err) {
        return errorJson(500, `ALLOW: ${(err as Error).message}`)
      }
      let authorize
      try {
        limits = workerLimits(env)
        authorize = oidcAuth({
          allow,
          readAccess: env.READ_ACCESS,
          ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}),
        })
      } catch (err) {
        return errorJson(500, (err as Error).message)
      }
      made = { key, authorize, limits }
    }
    // The bucket and cache are this request's: a Worker's I/O objects do not outlive it.
    return createCacheServer({
      blobs: r2Blobs(env.BLOBS, caches.open('vx-cache'), ctx),
      authorize: made.authorize,
      limits: made.limits,
    })(req)
  },
}
