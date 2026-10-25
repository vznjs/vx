// `vx-cache-server` on Cloudflare Workers: blobs in R2, the rest in D1.
// `wrangler.jsonc` deploys it; TRUST and AUDIENCE are vars in it. It fits the free
// plan (README.md § Workers' free plan).

import { evict, retentionFrom } from './evict.js'
import { oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { errorJson, Refusal } from './protocol.js'
import { createCacheServer, MAX_BATCH_LINE } from './server.js'
import { type Blobs, type Db, sqliteStore } from './store.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1Database {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}
export interface R2Bucket {
  put(name: string, body: ReadableStream<Uint8Array>): Promise<unknown>
  get(name: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
  delete(name: string): Promise<void>
}
declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export interface Env {
  readonly DB: D1Database
  readonly BLOBS: R2Bucket
  /** The CI repositories served and the jobs trusted (`parseTrust`), a JSON list. */
  readonly TRUST?: string
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  /** The largest artifact stored, in bytes. */
  readonly MAX_UPLOAD_BYTES?: string
  /** Days the trusted scope's artifacts, a branch's and the timings are kept. */
  readonly TRUSTED_DAYS?: string
  readonly BRANCH_DAYS?: string
  readonly TIMING_DAYS?: string
}

function d1Db(d1: D1Database): Db {
  return {
    all: async <T>(sql: string, params: readonly unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    run: async (sql, params) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .run()
      ).meta.changes,
    batch: async (statements) => {
      await d1.batch(statements.map((s) => d1.prepare(s)))
    },
  }
}

function r2Blobs(bucket: R2Bucket): Blobs {
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
    get: async (name) => (await bucket.get(name))?.body ?? null,
    delete: (name) => bucket.delete(name),
  }
}

/** One handler per isolate and settings: the schema is made once per isolate. */
let made: { key: string; handle: (req: Request) => Promise<Response> } | undefined

/** The largest request body Workers take on the free plan. */
const WORKERS_BODY_BYTES = 100 * 1024 * 1024

export default {
  // The Cron Trigger `wrangler.jsonc` names: what outlived its retention goes.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const { artifacts, timings } = await evict(
      sqliteStore(d1Db(env.DB)),
      r2Blobs(env.BLOBS),
      retentionFrom(env),
    )
    console.log(`vx-cache-server: evicted ${artifacts} artifacts, ${timings} timings`)
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const key = [env.TRUST, env.AUDIENCE, env.MAX_UPLOAD_BYTES].join('\0')
    if (made?.key !== key) {
      let trust
      try {
        trust = parseTrust(env.TRUST ?? '')
      } catch (err) {
        return errorJson(500, `TRUST: ${(err as Error).message}`)
      }
      const max = env.MAX_UPLOAD_BYTES === undefined ? undefined : Number(env.MAX_UPLOAD_BYTES)
      if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) {
        return errorJson(500, `MAX_UPLOAD_BYTES: not a byte count: ${env.MAX_UPLOAD_BYTES}`)
      }
      if (max !== undefined && max + MAX_BATCH_LINE > WORKERS_BODY_BYTES) {
        return errorJson(
          500,
          `MAX_UPLOAD_BYTES: at most ${WORKERS_BODY_BYTES - MAX_BATCH_LINE}: Workers take a body of 100 MB`,
        )
      }
      made = {
        key,
        handle: createCacheServer({
          blobs: r2Blobs(env.BLOBS),
          store: sqliteStore(d1Db(env.DB)),
          authorize: oidcAuth({ trust, ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}) }),
          ...(max === undefined ? {} : { maxUploadBytes: max }),
        }),
      }
    }
    return made.handle(req)
  },
}
