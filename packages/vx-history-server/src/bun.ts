#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-history-server` on Bun: the timings in one SQLite file (PROTOCOL.md,
// README.md).

import { Database } from 'bun:sqlite'
import { parseArgs } from 'node:util'
import { oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { timingDaysOf } from './days.js'
import { createHistoryServer } from './server.js'
import { type Db, sqliteStore } from './store.js'

const USAGE = `usage: vx-history-server [--db vx-history.sqlite] [--port 8080] [--host 0.0.0.0]
  TRUST        the CI repositories it serves and the jobs it trusts, a JSON list
               (README.md § CI tokens); only their OIDC tokens are taken
  AUDIENCE     the aud a CI token names (default: the origin it was sent to)
  READ_ACCESS  public: a request with no token reads a repository TRUST names
  TIMING_DAYS  days a task's timings outlive its last report (default 30)`

/** A SQLite file through bun:sqlite. */
export function sqliteDb(path: string): Db {
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  return {
    all: async <T>(sql: string, params: readonly unknown[]) =>
      db.query(sql).all(...(params as never[])) as T[],
    run: async (sql, params) => db.query(sql).run(...(params as never[])).changes,
  }
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: 'vx-history.sqlite' },
      port: { type: 'string', default: '8080' },
      host: { type: 'string', default: '0.0.0.0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  const env = Bun.env
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  let trust
  let timingDays
  try {
    trust = parseTrust(env.TRUST ?? '')
    timingDays = timingDaysOf(env.TIMING_DAYS)
  } catch (err) {
    fail((err as Error).message)
  }
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(values.db)),
    authorize: oidcAuth({
      trust,
      readAccess: env.READ_ACCESS,
      ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}),
    }),
    ...(timingDays === undefined ? {} : { timingDays }),
  })
  const server = Bun.serve({ hostname: values.host, port, fetch: handle })
  console.log(`vx-history-server on ${server.url.href}`)
  const stop = (): void => void server.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    // parseArgs names the flag it refused, not the ones there are.
    const usage = (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `\n${USAGE}` : ''
    fail(`${err instanceof Error ? err.message : String(err)}${usage}`)
  }
}
