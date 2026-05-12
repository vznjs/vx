// Local analytics dashboard. Reads directly from the cache SQLite DB
// (`.vzn/cache/cache.db`) and serves JSON over HTTP. The UI (PR #23+)
// renders these endpoints. The Cloudflare Worker variant (PR #26)
// implements the same wire shape over D1.
//
// Read-only: this server never writes. `vzn run` continues to own the
// DB; we share the file via WAL + busy_timeout (already set on writers).

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface DashboardServerOptions {
  cacheDir: string
  port?: number
  hostname?: string
}

export interface OverviewResponse {
  cache: {
    entryCount: number
    totalBytes: number
    runCountLast24h: number
    hitCountLast24h: number
    hitRateLast24h: number | null
  }
  recentRuns: RunSummary[]
}

export interface RunSummary {
  runId: string
  startedAt: number
  endedAt: number
  durationMs: number
  taskCount: number
  successCount: number
  cacheHitCount: number
  failedCount: number
}

export interface TaskRow {
  id: number
  hash: string
  project: string
  task: string
  status: string
  exitCode: number
  durationMs: number
  startedAt: number
  endedAt: number
  runId: string | null
  cpuMs: number | null
  peakRssBytes: number | null
  /** Stringified because JSON can't represent bigint. ns since run t=0. */
  wallclockStartNs: string | null
  wallclockEndNs: string | null
  cacheHit: boolean | null
  bytesUploaded: number | null
  bytesDownloaded: number | null
}

export interface SlowestTask {
  project: string
  task: string
  avgDurationMs: number
  maxDurationMs: number
  runCount: number
}

export interface CacheEntryRow {
  hash: string
  project: string
  task: string
  sizeBytes: number
  createdAt: number
  accessedAt: number
  exitCode: number
  durationMs: number
}

interface RunsRow {
  id: number
  hash: string
  project: string
  task: string
  status: string
  exit_code: number
  duration_ms: number
  started_at: number
  ended_at: number
  run_id: string | null
  cpu_ms: number | null
  peak_rss_bytes: number | null
  wallclock_start_ns: number | bigint | null
  wallclock_end_ns: number | bigint | null
  cache_hit: number | null
  bytes_uploaded: number | null
  bytes_downloaded: number | null
}

/**
 * Open a Bun HTTP server exposing the dashboard JSON API at `/api/*`.
 * Caller owns shutdown via `server.stop()`. The DB handle is closed
 * when the server stops.
 */
export function createDashboardServer(opts: DashboardServerOptions): ReturnType<typeof Bun.serve> {
  const dbPath = path.join(opts.cacheDir, 'cache.db')
  if (!existsSync(dbPath)) {
    // Open read-write so bun:sqlite can create the file on first launch.
    // The empty DB satisfies every endpoint with zero rows.
    new Database(dbPath, { create: true }).close()
  }
  const db = new Database(dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000')

  const port = opts.port ?? 4280
  const hostname = opts.hostname ?? '127.0.0.1'

  const server = Bun.serve({
    port,
    hostname,
    fetch: (req) => handleRequest(db, req),
  })

  // bun:sqlite has no `onClose`; we monkey-patch stop() so callers get
  // automatic cleanup when they shut the server down.
  const originalStop = server.stop.bind(server)
  server.stop = (closeActive?: boolean) => {
    const r = originalStop(closeActive)
    db.close()
    return r
  }

  return server
}

export async function handleRequest(db: Database, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  if (pathname === '/api/health') return json({ ok: true })
  if (pathname === '/api/overview') return json(getOverview(db))
  if (pathname === '/api/runs') {
    const limit = clamp(intParam(url, 'limit', 50), 1, 500)
    const since = intParam(url, 'since', 0)
    return json(getRuns(db, { limit, since }))
  }
  if (pathname.startsWith('/api/runs/')) {
    const runId = pathname.slice('/api/runs/'.length)
    if (!runId) return notFound()
    return json(getRunDetail(db, runId))
  }
  if (pathname === '/api/tasks/slowest') {
    const limit = clamp(intParam(url, 'limit', 20), 1, 200)
    return json(getSlowestTasks(db, limit))
  }
  if (pathname === '/api/cache/entries') {
    const limit = clamp(intParam(url, 'limit', 100), 1, 1000)
    return json(getCacheEntries(db, limit))
  }
  if (pathname.startsWith('/api/')) return notFound()
  return await serveStatic(pathname)
}

const UI_DIR = path.join(import.meta.dir, 'dashboard-ui')

/**
 * Serve a UI static asset. Returns 404 outside the UI tree. Everything
 * that isn't a known file falls through to `index.html` so the SPA's
 * hash router can take it from there (`/runs/abc` etc. all serve the
 * shell; the router handles routing).
 */
async function serveStatic(pathname: string): Promise<Response> {
  const requested = pathname === '/' ? '/index.html' : pathname
  // Path traversal guard: normalize and require the result to stay
  // under UI_DIR. `path.join` here resolves `..` segments.
  const absolute = path.join(UI_DIR, requested)
  if (!absolute.startsWith(UI_DIR)) return notFound()
  if (existsSync(absolute)) {
    return await fileResponse(absolute)
  }
  // SPA fallback: any unknown path that isn't an obvious asset request
  // gets the shell HTML.
  if (!/\.(js|css|html|ico|svg|png|jpg|woff2?)$/i.test(requested)) {
    return await fileResponse(path.join(UI_DIR, 'index.html'))
  }
  return notFound()
}

async function fileResponse(absolute: string): Promise<Response> {
  const buf = await readFile(absolute)
  return new Response(buf, {
    headers: {
      'content-type': contentTypeFor(absolute),
      // Don't cache during development — the user wants fresh data
      // every reload. The dashboard is a dev tool, not production.
      'cache-control': 'no-store',
    },
  })
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

export function getOverview(db: Database): OverviewResponse {
  const cache = getCacheStats(db)
  const recentRuns = getRuns(db, { limit: 10, since: 0 })
  return { cache, recentRuns }
}

function getCacheStats(db: Database): OverviewResponse['cache'] {
  const agg = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
    .get() as { n: number; bytes: number }
  const since = Date.now() - 24 * 60 * 60 * 1000
  const runs = db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0) AS hits FROM runs WHERE started_at >= ?",
    )
    .get(since) as { total: number; hits: number }
  return {
    entryCount: agg.n,
    totalBytes: agg.bytes,
    runCountLast24h: runs.total,
    hitCountLast24h: runs.hits,
    hitRateLast24h: runs.total > 0 ? runs.hits / runs.total : null,
  }
}

export function getRuns(db: Database, args: { limit: number; since: number }): RunSummary[] {
  // Group by run_id; null run_ids are rows produced before PR #21 — ignore.
  const rows = db
    .prepare(
      `SELECT
         run_id AS runId,
         MIN(started_at) AS startedAt,
         MAX(ended_at)   AS endedAt,
         COUNT(*) AS taskCount,
         SUM(CASE WHEN status = 'success'   THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END) AS cacheHitCount,
         SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failedCount
       FROM runs
       WHERE run_id IS NOT NULL AND started_at >= ?
       GROUP BY run_id
       ORDER BY startedAt DESC
       LIMIT ?`,
    )
    .all(args.since, args.limit) as Array<{
    runId: string
    startedAt: number
    endedAt: number
    taskCount: number
    successCount: number
    cacheHitCount: number
    failedCount: number
  }>
  return rows.map((r) => ({
    runId: r.runId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.endedAt - r.startedAt,
    taskCount: r.taskCount,
    successCount: r.successCount,
    cacheHitCount: r.cacheHitCount,
    failedCount: r.failedCount,
  }))
}

export function getRunDetail(db: Database, runId: string): { runId: string; tasks: TaskRow[] } {
  const rows = db
    .prepare(
      `SELECT * FROM runs
       WHERE run_id = ?
       ORDER BY COALESCE(wallclock_start_ns, started_at) ASC, id ASC`,
    )
    .all(runId) as RunsRow[]
  return { runId, tasks: rows.map(rowToTask) }
}

export function getSlowestTasks(db: Database, limit: number): SlowestTask[] {
  return db
    .prepare(
      `SELECT
         project,
         task,
         AVG(duration_ms) AS avgDurationMs,
         MAX(duration_ms) AS maxDurationMs,
         COUNT(*)         AS runCount
       FROM runs
       WHERE status IN ('success', 'failed')
       GROUP BY project, task
       ORDER BY avgDurationMs DESC
       LIMIT ?`,
    )
    .all(limit) as SlowestTask[]
}

export function getCacheEntries(db: Database, limit: number): CacheEntryRow[] {
  return db
    .prepare(
      `SELECT
         hash, project, task, size_bytes AS sizeBytes,
         created_at AS createdAt, accessed_at AS accessedAt,
         exit_code AS exitCode, duration_ms AS durationMs
       FROM entries
       ORDER BY accessed_at DESC
       LIMIT ?`,
    )
    .all(limit) as CacheEntryRow[]
}

function rowToTask(r: RunsRow): TaskRow {
  return {
    id: r.id,
    hash: r.hash,
    project: r.project,
    task: r.task,
    status: r.status,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    runId: r.run_id,
    cpuMs: r.cpu_ms,
    peakRssBytes: r.peak_rss_bytes,
    wallclockStartNs: r.wallclock_start_ns === null ? null : String(r.wallclock_start_ns),
    wallclockEndNs: r.wallclock_end_ns === null ? null : String(r.wallclock_end_ns),
    cacheHit: r.cache_hit === null ? null : r.cache_hit === 1,
    bytesUploaded: r.bytes_uploaded,
    bytesDownloaded: r.bytes_downloaded,
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function intParam(url: URL, name: string, dflt: number): number {
  const v = url.searchParams.get(name)
  if (v === null) return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : dflt
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
