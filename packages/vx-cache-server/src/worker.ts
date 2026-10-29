// `vx-cache-server` on Cloudflare Workers: artifacts in R2, nothing else.
// `wrangler.jsonc` deploys it; ALLOW, AUDIENCE and the limits are vars in
// it (README.md § On Cloudflare Workers).

import {
  type Authorize,
  cachedFetchJson,
  errorJson,
  type KeysCache,
  oidcAuth,
  parseAllow,
  Refusal,
} from '@vzn/vx-devtools'
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
  delete(key: Request): Promise<boolean>
}
declare const caches: { open(name: string): Promise<WorkersCache>; default: KeysCache }
export interface Context {
  waitUntil(p: Promise<unknown>): void
}
declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export interface Env {
  readonly BLOBS?: R2Bucket
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
 * under its name while R2 holds it, so a copy needs no expiry of its own;
 * an upload drops the copy, of bytes R2 has since let go. The server has
 * checked the token and named the object before a read reaches here.
 */

export function r2Blobs(bucket: R2Bucket, cache: Promise<WorkersCache>, ctx: Context): Blobs {
  return {
    async put(name, body, size) {
      // R2 takes a stream of known length; this one errors at any other.
      const fixed = new FixedLengthStream(size)
      const piped = body.pipeTo(fixed.writable)
      const [stored, read] = await Promise.allSettled([bucket.put(name, fixed.readable), piped])
      // A body of another length fails the pipe and R2's read of it with
      // one error. R2 failing of its own is the bucket's fault (a 502),
      // never the client's 400, though its stream's cancel fails the pipe.
      if (
        stored.status === 'rejected' &&
        (read.status === 'fulfilled' || stored.reason !== read.reason)
      )
        throw stored.reason
      if (read.status === 'rejected')
        throw new Refusal(400, `the body is not ${size} bytes: ${String(read.reason)}`)
      // R2 takes a name only once it holds none: a copy here is of bytes
      // R2 expired, a corrupt one too, and outlived the new ones a year.
      await (await cache).delete(keyOf(name))
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

/**
 * The issuer's keys through the data center's cache: a fresh isolate read
 * GitHub on its first token, and one slow answer failed it 502 (2026-10-29).
 * `caches.default` is read at each call, as the bucket is per request.
 */
const edgeKeys = cachedFetchJson({
  match: (url) => caches.default.match(url),
  put: (url, res) => caches.default.put(url, res),
})

export default {
  async fetch(req: Request, env: Env, ctx: Context): Promise<Response> {
    // A deploy's mistake, not R2's outage: unbound, every read was a 502.
    if (env.BLOBS === undefined) {
      return errorJson(500, 'BLOBS: bind an R2 bucket as BLOBS (wrangler.jsonc r2_buckets)')
    }
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
      // wrangler.jsonc may write a var as JSON: a list reached parseAllow.
      if (env.ALLOW !== undefined && typeof env.ALLOW !== 'string') {
        return errorJson(
          500,
          'ALLOW: one string of issuer:owner/repo:workflow entries, space separated',
        )
      }
      // Likewise AUDIENCE: "env.AUDIENCE.trim is not a function".
      if (env.AUDIENCE !== undefined && typeof (env.AUDIENCE as unknown) !== 'string') {
        return errorJson(500, 'AUDIENCE: one string, the aud CI tokens name')
      }
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
          fetchJson: edgeKeys,
          // jose matches aud exactly: a pasted newline refused every
          // token as the wrong audience.
          ...(env.AUDIENCE ? { audience: env.AUDIENCE.trim() } : {}),
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
