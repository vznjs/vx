// The Postgres seam (docs/design/cloud-platform-2026-07.md §7.1): a thin
// wrapper over Bun's built-in `SQL` client. Deliberately minimal — hand-written
// SQL flows through `db.sql` tagged templates everywhere; keeping construction
// in one file is the escape hatch if Bun.sql ever needs swapping out.

import { SQL } from 'bun'

export interface DbClient {
  sql: SQL
  close(): Promise<void>
}

/**
 * Connection options for a unix-socket DATABASE_URL. Bun.sql's URL parser
 * rejects the libpq empty-host socket form (`postgres://user@/db?host=/dir`),
 * so we detect it ourselves and hand Bun the options-object equivalent.
 */
export interface SocketConnection {
  path: string
  username: string
  password?: string
  database: string
}

/**
 * Parse a `postgres://` URL into unix-socket options when it uses the libpq
 * socket convention (empty authority host + a `?host=/…` query param), or
 * null for a plain TCP URL that Bun.sql parses natively.
 */
export function parseSocketDatabaseUrl(databaseUrl: string): SocketConnection | null {
  const m =
    /^postgres(?:ql)?:\/\/(?:([^:@/?]+)(?::([^@/?]*))?@)?([^/?]*)((?:\/[^?]*)?)(?:\?(.*))?$/.exec(
      databaseUrl,
    )
  if (m === null) return null
  const [, user, pass, host, pathPart, query] = m
  const params = new URLSearchParams(query ?? '')
  const socketHost = params.get('host')
  if (socketHost === null || !socketHost.startsWith('/')) return null
  if (host !== undefined && host !== '') return null
  const database = decodeURIComponent((pathPart ?? '').replace(/^\//, '')) || 'postgres'
  const out: SocketConnection = {
    path: socketHost,
    username: decodeURIComponent(user ?? 'postgres'),
    database,
  }
  if (pass !== undefined && pass !== '') out.password = decodeURIComponent(pass)
  return out
}

/**
 * Open a connection pool for a DATABASE_URL. Lazy: Bun.sql connects on the
 * first query, so callers that need a boot-time reachability check run a
 * `SELECT 1` themselves (the `server` entrypoint does).
 */
export function openDb(databaseUrl: string): DbClient {
  const socket = parseSocketDatabaseUrl(databaseUrl)
  const sql = socket !== null ? newSocketSql(socket) : new SQL(databaseUrl)
  return {
    sql,
    close: async () => {
      await sql.close()
    },
  }
}

/**
 * Construct a socket-connected SQL client. Bun.sql still consults
 * `process.env.DATABASE_URL` / `POSTGRES_URL` even when handed an explicit
 * options object, and the libpq socket form we parse here is exactly what
 * Bun's own URL parser rejects — so a socket URL sitting in the environment
 * (a compose/systemd deployment, our own `server` boot) would make the
 * construction throw "cannot be parsed as a URL". Shield the sync
 * construction from those two env vars, then restore them — the caller has
 * already captured the URL, so the environment is only a fallback we don't
 * want consulted here.
 */
function newSocketSql(socket: SocketConnection): SQL {
  const saved: Record<string, string | undefined> = {}
  for (const k of ['DATABASE_URL', 'POSTGRES_URL']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    return new SQL(socket)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  }
}
