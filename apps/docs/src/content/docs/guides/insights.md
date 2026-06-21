---
title: Insights dashboard
description: A Solid SPA bundled into vx serve. Run history, per-task averages, cache stats. One flag, no daemon.
---

The insights dashboard ships inside `vx serve` itself. Pass `--ui`
and the same backend that drives `vx run` delegation also serves
the SPA at `/`. One process, one stack.

## Quick start

```sh
cd your-workspace
vx serve --ui --open
```

That:

1. boots `vx serve` on a kernel-assigned port,
2. serves the bundled insights SPA at `/`,
3. opens your default browser at the same origin.

`Ctrl-C` stops it. Drop `--open` if you'd rather not auto-launch
a browser; drop `--ui` to get just the JSON API + WS + SSE.

Pin a port with `--port`:

```sh
vx serve --ui --port 4321
```

## What you see

- **Overview** — hero cards (time saved 24h, hit rate, entries,
  total time saved), Top time-burners + Recent failures, cache
  bytes per project, recent invocations.
- **Tasks** — sortable table over every `(project, task)`: runs,
  success rate, hit rate, avg, p50, p99, total time, last run;
  substring filter; failure-mode dot.
- **Task detail** — 10 stat cards (min/avg/p50/p99/max, success/hit
  rate, failure mode, last run), duration sparkline of the last 100
  runs with cache hits marked, latest cache-entry card, full
  recent-run table with CPU + peak RSS + hash.
- **Cache** — sortable entries table (largest/newest/recently-
  accessed/slowest), by-project bytes breakdown.
- **Run detail** — per-task timeline flamegraph, lane per project,
  bars colored by status / cache source.

A **connection picker** in the top-right shows the current server
origin and a status dot. Click it to paste a different URL and the
SPA reconnects — `http://localhost:4321` for another local server,
or `https://vx.your-company.com` for a hosted one. Useful when you
host the SPA once and let everyone aim it at their own backend.

## How it works

```
   Browser
   ┌─────────────────────────────┐
   │ apps/insights SPA (Solid)   │
   │  • connection picker        │
   │  • fetch over HTTP          │
   └────────┬────────────────────┘
            │ GET /v1/runs, /v1/invocations, …
            │ WS /  (delegated run submission)
            ▼
   ┌─────────────────────────────┐
   │ vx serve --ui  (Bun.serve)  │
   │  • /v1/* JSON over cache.db │
   │  • SPA static at /          │
   │  • CORS *                   │
   │  • SSE event stream         │
   │  • WS run protocol          │
   └────────┬────────────────────┘
            │ bun:sqlite
            ▼
   ┌─────────────────────────────┐
   │ <workspaceRoot>/.vx/cache/  │
   │  cache.db                   │
   └─────────────────────────────┘
```

## HTTP surface

`vx serve` exposes:

| Path | Returns |
| --- | --- |
| `GET /health` | `ok` |
| `GET /version` | `{ vx, protocol, workspace, channels, rpc }` |
| `GET /v1/runs?project=&task=&runId=&limit=` | per-task run rows |
| `GET /v1/invocations?limit=` | grouped per `runId` |
| `GET /v1/runs/:runId` | full run detail + tasks |
| `GET /v1/tasks/:taskId` | per-task aggregate + recent + latest entry |
| `GET /v1/top-tasks?limit=` | biggest time-burners |
| `GET /v1/failures?limit=` | recent failed runs |
| `GET /v1/history?project=&task=&limit=` | rollups w/ p50/p99 |
| `GET /v1/cache/stats` | entry count, size, 24h hit rate |
| `GET /v1/cache/savings` | estimated time the cache saved you |
| `GET /v1/cache/breakdown?limit=` | bytes per project |
| `GET /v1/cache/entries?orderBy=size_bytes\|created_at\|accessed_at\|duration_ms&project=&limit=` | entries table |
| `GET /v1/explain/:taskId` | latest cache-key entry |
| `GET /v1/why/:runId/:taskId` | compare hash with previous run |
| `GET /events`, `GET /v1/events` | SSE stream of run events |

All routes ship `Access-Control-Allow-Origin: *`.

## Host the SPA once, point it anywhere

You can also build `apps/insights/dist/` and deploy it to any static
host. The connection picker means the same hosted bundle works
against any reachable `vx serve` — browsers allow HTTPS pages to
call `http://localhost:*` per the Secure Context exception, so a
hosted `https://insights.example.com` reading from a local
`http://localhost:4321` Just Works.

## Privacy

When you run `vx serve --ui` locally, nothing leaves your machine.
A hosted SPA pointed at `http://localhost:*` is also entirely
local — the picker is just configuration; the page reads from
your machine, not a third party.

## Known limits

- **No real-time view yet.** SSE event streaming exists on the
  server (`/v1/events`) but the SPA doesn't subscribe yet. Reload
  to see new runs.
- **No auth.** `vx serve` binds to localhost by default; trust is
  by network reachability. Add a reverse proxy with auth for
  hosted deployments.

See also: [`Self-hosting`](/vx/guides/self-hosting/),
[`Wire protocol`](/vx/guides/wire-protocol/).
