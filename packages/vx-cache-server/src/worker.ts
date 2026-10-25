// `vx-cache-server` on Cloudflare Workers: artifacts in R2, nothing else.
// `wrangler.jsonc` deploys it; TRUST, AUDIENCE and the limits are vars in
// it. It fits the free plan (README.md § On Cloudflare Workers).

import { type Authorize, oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { errorJson, Refusal } from './protocol.js'
import { createCacheServer, DEFAULT_LIMITS, type Limits, lineBytes, limitsFrom } from './server.js'
import type { Blobs } from './store.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
export interface R2Bucket {
  put(name: string, body: ReadableStream<Uint8Array>): Promise<unknown>
  get(name: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>
  head(name: string): Promise<{ size: number } | null>
}
declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}
interface WorkersCache {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, res: Response): Promise<void>
}
declare const caches: { open(name: string): Promise<WorkersCache> }
/** What a request may leave running after its answer. */
export interface Context {
  waitUntil(p: Promise<unknown>): void
}

export interface Env {
  readonly BLOBS: R2Bucket
  /** The CI repositories served and the refs they protect (`parseTrust`), a JSON list. */
  readonly TRUST?: string
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  readonly MAX_CHECK_KEYS?: string
  readonly MAX_BATCH_ARTIFACTS?: string
  readonly MAX_UPLOAD_BYTES?: string
}

/**
 * Cache API calls one request makes, of the 50 the free plan allows
 * (a `match` and, on a miss, a `put` per artifact); past them a read goes
 * to R2 alone.
 */
const CACHE_CALLS = 40

/**
 * R2, read through this data center's Workers Cache: a hit answered from
 * IAD in 0.2 s where R2 (WNAM) took 0.7 to 1 s for 43 MB (M, 2026-10-25).
 * An artifact never changes, so a cached copy never goes stale. Every
 * read reaches here after its token and scope are checked.
 */
function r2Blobs(bucket: R2Bucket, cache: Promise<WorkersCache>, ctx: Context): Blobs {
  let calls = 0
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
    async get(name) {
      const cached = calls + 2 <= CACHE_CALLS
      const key = new Request(`https://vx-cache.blobs/${name}`)
      if (cached) {
        calls++
        const hit = await (await cache).match(key)
        if (hit?.body) return { body: hit.body, size: Number(hit.headers.get('content-length')) }
      }
      const o = await bucket.get(name)
      if (o === null) return null
      if (!cached) return { body: o.body, size: o.size }
      calls++
      const [body, copy] = o.body.tee()
      ctx.waitUntil(
        (await cache).put(
          key,
          new Response(copy, {
            headers: {
              'content-length': String(o.size),
              'cache-control': 'public, max-age=604800, immutable',
            },
          }),
        ),
      )
      return { body, size: o.size }
    },
    size: async (name) => (await bucket.head(name))?.size ?? null,
  }
}

/** The largest request body Workers take on the free plan. */
const WORKERS_BODY_BYTES = 100 * 1024 * 1024
/**
 * Calls to Cloudflare's services one request may make on the free plan.
 * A check makes one per key, a batch download two per artifact and an
 * upload up to three, so each limit is clamped to fit it.
 */
const SERVICE_CALLS = 1000

/** The limits as set, clamped to what one Worker request can make. */
function workerLimits(env: Env): Limits {
  const set = { ...DEFAULT_LIMITS, ...limitsFrom(env) }
  const limits = {
    maxCheckKeys: Math.min(set.maxCheckKeys, SERVICE_CALLS - 10),
    maxBatchArtifacts: Math.min(set.maxBatchArtifacts, Math.floor((SERVICE_CALLS - 10) / 3)),
    maxUploadBytes: set.maxUploadBytes,
  }
  if (limits.maxUploadBytes + lineBytes(limits.maxBatchArtifacts) > WORKERS_BODY_BYTES) {
    throw new Error(
      `MAX_UPLOAD_BYTES: at most ${WORKERS_BODY_BYTES - lineBytes(limits.maxBatchArtifacts)}: Workers take a body of 100 MB`,
    )
  }
  return limits
}

/** Settings read once per isolate; the token check keeps its keys across requests. */
let made: { key: string; authorize: Authorize; limits: Limits } | undefined

export default {
  async fetch(req: Request, env: Env, ctx: Context): Promise<Response> {
    const key = [
      env.TRUST,
      env.AUDIENCE,
      env.MAX_CHECK_KEYS,
      env.MAX_BATCH_ARTIFACTS,
      env.MAX_UPLOAD_BYTES,
    ].join('\0')
    if (made?.key !== key) {
      let trust
      let limits
      try {
        trust = parseTrust(env.TRUST ?? '')
      } catch (err) {
        return errorJson(500, `TRUST: ${(err as Error).message}`)
      }
      try {
        limits = workerLimits(env)
      } catch (err) {
        return errorJson(500, (err as Error).message)
      }
      made = {
        key,
        authorize: oidcAuth({ trust, ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}) }),
        limits,
      }
    }
    // A server a request: its Cache API calls are counted per request.
    return createCacheServer({
      blobs: r2Blobs(env.BLOBS, caches.open('vx-cache'), ctx),
      authorize: made.authorize,
      limits: made.limits,
    })(req)
  },
}
