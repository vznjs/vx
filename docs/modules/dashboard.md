# `dashboard.ts` — local analytics server

## Purpose

Serve a JSON API over the local cache SQLite DB so the dashboard UI
(PR #23+) and external integrations can query run history, cache
state, and per-task analytics without going through the CLI. Read-only
— `vzn run` continues to own the database; this server opens
`cache.db` with `{ readonly: true }` and shares the file via WAL.

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

## Cloudflare port (forward-looking)

PR #26 will ship a `cf-dashboard/` template that implements the same
wire shape over a D1 database. Clients (the UI + any third-party
integration) won't need to know whether they're hitting a local Bun
server or a Cloudflare Worker — same endpoints, same JSON.
