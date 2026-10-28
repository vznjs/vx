#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-history-server` on Bun: the timings in one SQLite file (PROTOCOL.md,
// README.md).

import { Database } from 'bun:sqlite'
import { parseArgs } from 'node:util'
import { oidcTokenAuth, parseAllow } from '@vzn/vx-devtools'
import { timingDaysOf } from './days.js'
import { createHistoryServer } from './server.js'
import { type Db, sqliteStore } from './store.js'

const USAGE = `usage: vx-history-server [--db vx-history.sqlite] [--port 8080] [--host 0.0.0.0]
  ALLOW        who may take part, space separated, each issuer:owner/repo:workflow
               (README.md § CI tokens); only their jobs' OIDC tokens are taken
  AUDIENCE     the aud a CI token names: the URL clients reach this server at
  READ_ACCESS  public: a request with no token reads a repository ALLOW names
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
  // Number('') is 0: `--port "$PORT"` with PORT unset bound a random port.
  const port = values.port.trim() === '' ? Number.NaN : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  let allow
  let timingDays
  try {
    allow = parseAllow(env.ALLOW ?? '')
  } catch (err) {
    fail(`ALLOW: ${(err as Error).message}`)
  }
  try {
    timingDays = timingDaysOf(env.TIMING_DAYS)
  } catch (err) {
    fail((err as Error).message)
  }
  // bun:sqlite opens '' as a temporary database: every timing was gone at
  // the next restart, and nothing said so.
  if (values.db === '') fail(`--db: needs a file path, got ''\n${USAGE}`)
  let db
  try {
    db = sqliteDb(values.db)
  } catch (err) {
    // SQLite's own message ("unable to open database file") named no path.
    fail(`--db ${values.db}: ${(err as Error).message}`)
  }
  // Unset, the audience would be the origin a request names: its Host
  // header, which the client picks. Workers know their own hostnames.
  const audience = env.AUDIENCE?.trim() ?? ''
  if (audience === '')
    fail(`set AUDIENCE: the aud a CI token names, the URL clients reach this server at\n${USAGE}`)
  const handle = createHistoryServer({
    store: sqliteStore(db),
    authorize: oidcTokenAuth({
      allow,
      readAccess: env.READ_ACCESS,
      audience,
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
