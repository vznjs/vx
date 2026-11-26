#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-history-server` on Bun: the timings in one SQLite file (PROTOCOL.md,
// README.md).

import { Database } from 'bun:sqlite'
import { parseArgs } from 'node:util'
import { oidcTokenAuth, parseAllow, statusLine } from '@vzn/vx-devtools'
import { timingDaysOf } from './days.js'
import { createHistoryServer } from './server.js'
import { type Db, notOurs, sqliteStore, TABLES } from './store.js'

const USAGE = `usage: vx-history-server [--db vx-history.sqlite] [--port 8080] [--host 0.0.0.0]
  ALLOW        who may take part, space separated, each issuer:owner/repo:workflow
               (README.md § CI tokens); only their jobs' OIDC tokens are taken
  AUDIENCE     the aud a CI token names: the origin clients reach this server at
  READ_ACCESS  public: a request with no token reads a repository ALLOW names
  TIMING_DAYS  days a task's timings outlive its last report (default 30)`

/** A SQLite file through bun:sqlite. */
export function sqliteDb(path: string): Db {
  const db = new Database(path, { create: true, strict: true })
  // bun:sqlite waits for a lock on the server's one thread, stalling every
  // request: a fold takes ms, so a lock held past this is no other fold's.
  db.run('PRAGMA busy_timeout = 1000')
  // A file another tool made started the server, and its first upload
  // failed 500 after init had altered that tool's table.
  for (const table of TABLES.keys()) {
    const why = notOurs(
      table,
      new Set(
        db
          .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?1)')
          .all(table)
          .map((c) => c.name),
      ),
    )
    if (why !== undefined) {
      db.close()
      throw new Error(why)
    }
  }
  toWal(db)
  return {
    all: async <T>(sql: string, params: readonly unknown[]) =>
      db.query(sql).all(...(params as never[])) as T[],
    run: async (sql, params) => db.query(sql).run(...(params as never[])).changes,
  }
}

/**
 * The file in WAL mode. The switch takes the file whole and SQLite asks no
 * busy handler for it: two servers starting on a new file raced, and the
 * loser died of "database is locked". Tried again within the busy timeout.
 */
function toWal(db: Database): void {
  for (const until = Date.now() + 1000; ;) {
    try {
      db.run('PRAGMA journal_mode = WAL')
      return
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= until) throw err
      Bun.sleepSync(10)
    }
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
  // Digits only: Number('') is 0, a random port for `--port "$PORT"` with
  // PORT unset, and Number read 0x50 as 80 and 1e1 as 10.
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  // Bun.serve reads '' as localhost: unreachable from another host or container.
  if (values.host.trim() === '') fail(`--host: needs an address, got '${values.host}'`)
  let allow
  let timingDays
  try {
    allow = parseAllow(env['ALLOW'] ?? '')
  } catch (err) {
    fail(`ALLOW: ${(err as Error).message}`)
  }
  // An empty one started a server that refused every request.
  if (allow.length === 0) fail(`set ALLOW\n${USAGE}`)
  try {
    timingDays = timingDaysOf(env['TIMING_DAYS'])
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
  const audience = env['AUDIENCE']?.trim() ?? ''
  if (audience === '')
    fail(
      `set AUDIENCE: the aud a CI token names, the origin clients reach this server at\n${USAGE}`,
    )
  const handle = createHistoryServer({
    store: sqliteStore(db),
    authorize: oidcTokenAuth({
      allow,
      readAccess: env['READ_ACCESS'],
      audience,
    }),
    ...(timingDays === undefined ? {} : { timingDays }),
  })
  const server = Bun.serve({ hostname: values.host, port, fetch: handle })
  process.stdout.write(statusLine('ok', 'vx-history-server', `listening on ${server.url.href}`))
  const stop = (): void => void server.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(statusLine('err', 'vx-history-server', message))
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
