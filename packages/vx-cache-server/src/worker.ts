// `vx-cache-server` on Cloudflare Workers: blobs in R2, the rest in D1.
// `wrangler.jsonc` deploys it; TOKENS is a var in it. It fits the free
// plan (README.md § Workers' free plan).

import { parseTokens, tokenAuth } from './auth.js'
import { problem, Refusal } from './protocol.js'
import { createCacheServer } from './server.js'
import type { Blobs, Db } from './store.js'

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
  /** Who may read and write (`parseTokens`): `read:<sha256>` / `write:<sha256>`, space separated. */
  readonly TOKENS?: string
  /** The largest artifact stored, in bytes. */
  readonly MAX_ARTIFACT_BYTES?: string
}

export function d1Db(d1: D1Database): Db {
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

export function r2Blobs(bucket: R2Bucket): Blobs {
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const key = `${env.TOKENS ?? ''}\0${env.MAX_ARTIFACT_BYTES ?? ''}`
    if (made?.key !== key) {
      let tokens
      try {
        tokens = parseTokens(env.TOKENS ?? '')
      } catch (err) {
        return problem(500, `TOKENS: ${(err as Error).message}`)
      }
      const max = env.MAX_ARTIFACT_BYTES === undefined ? undefined : Number(env.MAX_ARTIFACT_BYTES)
      if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) {
        return problem(500, `MAX_ARTIFACT_BYTES: not a byte count: ${env.MAX_ARTIFACT_BYTES}`)
      }
      made = {
        key,
        handle: createCacheServer({
          blobs: r2Blobs(env.BLOBS),
          db: d1Db(env.DB),
          authorize: tokenAuth(tokens),
          ...(max === undefined ? {} : { maxArtifactBytes: max }),
        }),
      }
    }
    return made.handle(req)
  },
}
