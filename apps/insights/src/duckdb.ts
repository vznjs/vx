// Lazy DuckDB-WASM loader. DuckDB reads SQLite files directly via the
// `sqlite_scanner` extension — no ETL, no server. The cache.db URL is
// resolved once and ATTACHed; queries then read the live SQLite via
// `sqlite_attached.<table>` aliases exposed in api.ts.
//
// The bundle is ~30MB; loadDuckDb() is deferred until the first call.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

let dbPromise: Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> | undefined

function resolveCacheDbUrl(): string {
  const injected = import.meta.env.VITE_CACHE_DB_URL
  if (typeof injected === 'string' && injected.length > 0) return injected
  // Default for local dev: `vx insights serve` boots a static server that
  // exposes cache.db at /cache.db on the same origin.
  return '/cache.db'
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
  await conn.query(`INSTALL sqlite_scanner; LOAD sqlite_scanner;`)
  const cacheDbUrl = resolveCacheDbUrl()
  await conn.query(`ATTACH '${cacheDbUrl}' AS cachedb (TYPE SQLITE);`)
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
