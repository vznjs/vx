// `vx-history-server` on Cloudflare Workers, the timings in D1.
// `wrangler.jsonc` deploys it; ALLOW, AUDIENCE, READ_ACCESS and TIMING_DAYS
// are vars in it.

import { errorJson, oidcTokenAuth, parseAllow } from '@vzn/vx-devtools'
import { timingDaysOf } from './days.js'
import { createHistoryServer } from './server.js'
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
  readonly DB?: D1Database
  /** Who may take part (`parseAllow`): `issuer:owner/repo:workflow` entries, space separated. */
  readonly ALLOW?: string
  /** The `aud` a CI token names; unset, the origin the Worker is reached at. */
  readonly AUDIENCE?: string
  /** `public`: a request with no token reads a repository ALLOW names. */
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
    // A deploy's mistake: unbound, capabilities answered and every upload failed.
    if (env.DB === undefined) {
      return errorJson(500, 'DB: bind a D1 database as DB (wrangler.jsonc d1_databases)')
    }
    const key = [env.ALLOW, env.AUDIENCE, env.READ_ACCESS, env.TIMING_DAYS].join('\0')
    if (made?.key !== key) {
      let allow
      // wrangler.jsonc may write a var as JSON: a list reached parseAllow.
      if (env.ALLOW !== undefined && typeof env.ALLOW !== 'string') {
        return errorJson(
          500,
          'ALLOW: one string of issuer:owner/repo:workflow entries, space separated',
        )
      }
      try {
        allow = parseAllow(env.ALLOW ?? '')
      } catch (err) {
        return errorJson(500, `ALLOW: ${(err as Error).message}`)
      }
      let authorize
      let timingDays
      try {
        timingDays = timingDaysOf(env.TIMING_DAYS)
        authorize = oidcTokenAuth({
          allow,
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
