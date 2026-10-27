// `vx-history-server` on Cloudflare Workers, the timings in D1.
// `wrangler.jsonc` deploys it; TRUST, AUDIENCE and TIMING_DAYS are vars in
// it.

import { oidcTokenAuth, parseTrust } from '@vzn/vx-devtools'
import { timingDaysOf } from './days.js'
import { createHistoryServer, errorJson } from './server.js'
import { type Db, sqliteStore } from './store.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1Database {
  prepare(sql: string): D1Statement
}

export interface Env {
  readonly DB: D1Database
  /** The CI repositories served and the refs they protect (`parseTrust`), a JSON list. */
  readonly TRUST?: string | readonly unknown[]
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  /** `public`: a request with no token reads a repository TRUST names. */
  readonly READ_ACCESS?: string
  /** Days a task's timings outlive its last report (default 30). */
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
  }
}

/** One handler per isolate and settings: the schema is made once per isolate. */
let made: { key: string; handle: (req: Request) => Promise<Response> } | undefined

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const key = [trustOf(env), env.AUDIENCE, env.READ_ACCESS, env.TIMING_DAYS].join('\0')
    if (made?.key !== key) {
      let authorize
      let timingDays
      try {
        timingDays = timingDaysOf(env.TIMING_DAYS)
        authorize = oidcTokenAuth({
          trust: parseTrust(trustOf(env)),
          readAccess: env.READ_ACCESS,
          ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}),
        })
      } catch (err) {
        return errorJson(500, (err as Error).message)
      }
      made = {
        key,
        handle: createHistoryServer({
          store: sqliteStore(d1Db(env.DB)),
          authorize,
          ...(timingDays === undefined ? {} : { timingDays }),
        }),
      }
    }
    return made.handle(req)
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
