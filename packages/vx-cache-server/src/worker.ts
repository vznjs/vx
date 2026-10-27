// `vx-cache-server` on Cloudflare Workers: artifacts in R2, nothing else.
// `wrangler.jsonc` deploys it; TRUST, AUDIENCE and the limits are vars in
// it (README.md § On Cloudflare Workers).

import { type Authorize, oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { errorJson, Refusal } from './protocol.js'
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
  /** The CI repositories served and the refs they protect (`parseTrust`), a JSON list. */
  readonly TRUST?: string | readonly unknown[]
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  /** `public`: a request with no token reads a repository TRUST names. */
  readonly READ_ACCESS?: string
  readonly MAX_CHECK_HASHES?: string
  readonly MAX_UPLOAD_BYTES?: string
}

/** An object's key in the data center's cache. */
const keyOf = (name: string): Request => new Request(`https://vx-cache.blobs/${name}`)

/**
 * R2, read through the data center's cache: an artifact never changes
 * under its name, so a copy needs no expiry of its own. The server has
 * checked the token and named the object before a read reaches here.
 */

function r2Blobs(bucket: R2Bucket, cache: Promise<WorkersCache>, ctx: Context): Blobs {
  return {
    async put(name, body, size) {
      // R2 takes a stream of known length; this one errors at any other.
      const fixed = new FixedLengthStream(size)
      const piped = body.pipeTo(fixed.writable)
      try {
        await Promise.all([bucket.put(name, fixed.readable), piped])
      } catch (err) {
        throw new Refusal(400, `the body is not ${size} bytes: ${String(err)}`)
      }
    },
    get: async (name) => {
      const key = keyOf(name)
      const hit = await (await cache).match(key)
      if (hit?.body) return { body: hit.body, size: Number(hit.headers.get('content-length')) }
      const o = await bucket.get(name)
      if (o === null) return null
      const [body, copy] = o.body.tee()
      const headers = {
        'content-length': String(o.size),
        'cache-control': 'public, max-age=31536000, immutable',
      }
      ctx.waitUntil(cache.then((c) => c.put(key, new Response(copy, { headers }))))
      return { body, size: o.size }
    },
    // A check or HEAD asks the data center's copy first: free, and no R2
    // call. A miss is never kept, since the artifact may come a minute later.
    size: async (name) => {
      const hit = await (await cache).match(keyOf(name))
      if (hit !== undefined) {
        await hit.body?.cancel()
        return Number(hit.headers.get('content-length'))
      }
      return (await bucket.head(name))?.size ?? null
    },
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
      trustOf(env),
      env.AUDIENCE,
      env.READ_ACCESS,
      env.MAX_CHECK_HASHES,
      env.MAX_UPLOAD_BYTES,
    ].join('\0')
    if (made?.key !== key) {
      let trust
      let limits
      try {
        trust = parseTrust(trustOf(env))
      } catch (err) {
        return errorJson(500, `TRUST: ${(err as Error).message}`)
      }
      let authorize
      try {
        limits = workerLimits(env)
        authorize = oidcAuth({
          trust,
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

/**
 * `TRUST` as `parseTrust` reads it: wrangler hands a var written as a JSON
 * list in `wrangler.jsonc` to the Worker as that list, not as text.
 */
function trustOf(env: Env): string {
  return typeof env.TRUST === 'string'
    ? env.TRUST
    : env.TRUST === undefined
      ? ''
      : JSON.stringify(env.TRUST)
}
