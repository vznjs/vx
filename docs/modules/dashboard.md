# `dashboard.ts` — local analytics server + UI

## Purpose

Serve a JSON API over the local cache SQLite DB plus a static UI
bundle. Read-only — `vzn run` continues to own the database; this
server opens `cache.db` with `{ readonly: true }` and shares the
file via WAL.

The UI lives under `src/dashboard-ui/`: vanilla HTML + ESM + a tiny
hash router. No build step, no framework. Pages added over the
dashboard PR sequence: Overview + Cache (PR #23); Tasks + Runs
(PR #24); Run detail + flamegraph (PR #25).

## Public surface

```ts
export interface DashboardServerOptions {
  cacheDir: string
  port?: number // default 4280
  hostname?: string // default 127.0.0.1
}

export function createDashboardServer(opts: DashboardServerOptions): Server
export function handleRequest(db: Database, req: Request): Promise<Response>
```

`createDashboardServer` returns a `Bun.Server`. Calling `server.stop()`
also closes the underlying DB handle.

## Endpoints

All under `/api/`. JSON in/out. Numbers are JSON numbers; `bigint`
fields (wallclock spans) are serialized as strings.

### `GET /api/health`

Liveness probe.

```json
{ "ok": true }
```

### `GET /api/overview`

Cache stats + 10 most-recent runs.

```json
{
  "cache": {
    "entryCount": 42,
    "totalBytes": 1048576,
    "runCountLast24h": 100,
    "hitCountLast24h": 70,
    "hitRateLast24h": 0.7
  },
  "recentRuns": [ { /* RunSummary */ }, ... ]
}
```

### `GET /api/runs?since=<ms>&limit=<n>`

Recent runs grouped by `run_id`. `since` is a ms-epoch threshold
(default 0); `limit` defaults to 50, clamped 1–500.

```json
[
  {
    "runId": "01HX...",
    "startedAt": 1730000000000,
    "endedAt": 1730000005000,
    "durationMs": 5000,
    "taskCount": 12,
    "successCount": 7,
    "cacheHitCount": 5,
    "failedCount": 0
  }
]
```

Rows with `run_id IS NULL` (legacy data predating PR #21) are excluded.

### `GET /api/runs/:runId`

Every task that participated in one `vzn run` invocation. Ordered by
`wallclock_start_ns` so the flamegraph (PR #25) can lane-pack
deterministically.

```json
{
  "runId": "01HX...",
  "tasks": [
    {
      "id": 1234,
      "hash": "abc123...",
      "project": "@scope/pkg",
      "task": "build",
      "status": "success",
      "exitCode": 0,
      "durationMs": 450,
      "startedAt": 1730000000000,
      "endedAt": 1730000000450,
      "runId": "01HX...",
      "cpuMs": 380,
      "peakRssBytes": 67108864,
      "wallclockStartNs": "0",
      "wallclockEndNs": "450000000",
      "cacheHit": false,
      "bytesUploaded": null,
      "bytesDownloaded": null
    }
  ]
}
```

Unknown `runId` returns `{ "runId": ..., "tasks": [] }`.

### `GET /api/tasks/slowest?limit=<n>`

Slowest tasks ranked by average `duration_ms`. `cache-hit` and
`skipped` rows are excluded (they have ~0 ms and would distort the
ranking).

```json
[
  {
    "project": "...",
    "task": "build",
    "avgDurationMs": 6234,
    "maxDurationMs": 12000,
    "runCount": 14
  }
]
```

### `GET /api/cache/entries?limit=<n>`

Cache entry index, MRU first. Default 100, clamped 1–1000.

```json
[
  {
    "hash": "abc...",
    "project": "@scope/pkg",
    "task": "build",
    "sizeBytes": 1048576,
    "createdAt": 1730000000000,
    "accessedAt": 1730000005000,
    "exitCode": 0,
    "durationMs": 450
  }
]
```

## CLI

```sh
vzn dashboard                  # 127.0.0.1:4280
vzn dashboard --port 9090
vzn dashboard --port 0         # let the kernel pick (useful in tests)
vzn dashboard --host 0.0.0.0   # listen on all interfaces
```

The process blocks on SIGINT / SIGTERM; the server stops and the DB
handle closes on shutdown.

## Why direct SQL, not the `Cache` class

The dashboard exposes a different read model than the cache's hot
path. Grouping by `run_id`, ranking by `AVG(duration_ms)`, joining
entries and runs — none of those belong on `CacheLayer`, which is
already the orchestrator's contract. Keeping them in this module
avoids polluting the cache API for read patterns nobody else needs.

## Static UI bundle

Non-`/api/*` paths serve assets from `src/dashboard-ui/`. The router
is hash-based (`#/overview`, `#/cache`, …) so the server only needs
one fallback rule:

- known asset (`.css`, `.js`, `.html`, `.svg`, `.png`, `.ico`,
  `.woff?`) → file from disk, or 404
- everything else → `index.html` (SPA shell)

The shell loads `/app.js` which imports each page module on demand.
Pages call `/api/*` directly with `fetch`. No bundler.

`Cache-Control: no-store` on every static response: this is a dev
tool and the user wants fresh data on every reload.

`UI_DIR` resolves via `import.meta.dir`, so the published npm package
serves the bundle straight out of `src/dashboard-ui/` with no build
step.

## Cloudflare port (forward-looking)

PR #26 will ship a `cf-dashboard/` template that implements the same
wire shape over a D1 database. The static UI bundle is portable: the
Worker will serve the same files via the Workers static-assets
binding so the dashboard ships once and runs in two places.
