// Lazy DuckDB-WASM loader. DuckDB reads SQLite files via the
// `sqlite_scanner` extension — but only from its own virtual
// filesystem. We can't `ATTACH 'http://...'` directly because the
// SQLite reader doesn't speak HTTP. The flow is:
//   1. fetch the cache.db bytes from the static server
//   2. register them as a virtual file via `db.registerFileBuffer`
//   3. `ATTACH '<virtual-name>' AS cachedb (TYPE SQLITE)`
//
// Queries then read the live SQLite via `cachedb.<table>` aliases
// exposed in api.ts. The bundle is ~30MB; loadDuckDb() is deferred
// until the first call.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

let dbPromise: Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> | undefined

function resolveCacheDbUrl(): string {
  const injected = import.meta.env.VITE_CACHE_DB_URL
  if (typeof injected === 'string' && injected.length > 0) return injected
  // Default for local dev: `vx insights serve` boots a static server that
  // exposes cache.db at /cache.db on the same origin.
  return '/cache.db'
}

async function fetchCacheDbBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(
      `vx insights: failed to fetch ${url} (${res.status} ${res.statusText}). ` +
        `Is \`vx insights serve\` running? Did a \`vx run\` populate the cache yet?`,
    )
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

async function bootstrap(): Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> {
  const duckdb = await import('@duckdb/duckdb-wasm')
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  // The worker URL must be served same-origin or with permissive CORS; the
  // JsDelivr bundle handles that for us via a Blob shim.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)

  const conn = await db.connect()
  // sqlite_scanner reads a SQLite file from DuckDB's own virtual
  // filesystem. We fetch the bytes once and register them as a
  // virtual file named 'cache.db'; ATTACH then reads from there.
  await conn.query(`INSTALL sqlite_scanner; LOAD sqlite_scanner;`)
  const cacheDbUrl = resolveCacheDbUrl()
  const bytes = await fetchCacheDbBytes(cacheDbUrl)
  await db.registerFileBuffer('cache.db', bytes)
  await conn.query(`ATTACH 'cache.db' AS cachedb (TYPE SQLITE);`)
  return { db, conn }
}

export function loadDuckDb(): Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> {
  if (!dbPromise) dbPromise = bootstrap()
  return dbPromise
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const { conn } = await loadDuckDb()
  const result = await conn.query(sql)
  return result.toArray().map((row) => row.toJSON() as T)
}
