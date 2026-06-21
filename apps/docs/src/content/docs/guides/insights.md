---
title: vx insights — local & hosted dashboard
description: A Solid SPA that talks to vx serve over HTTP. Same UI locally or against a remote server. Run history, flamegraphs, cache stats, no daemon.
---

`vx insights` opens a dashboard backed by `vx serve` — the same
unified backend used everywhere. Run it locally for a private,
client-side view of your workspace; or point a hosted copy of the
SPA at any reachable `vx serve` for a team view. One platform.

## Quick start

```sh
cd your-workspace
vx insights
```

This boots two foreground processes:

- **`vx serve`** on a kernel-assigned port, exposing the JSON `/v1/*`
  insights API + the WebSocket run-submission protocol.
- **The SPA** (Vite dev server) on `http://127.0.0.1:5290`.

`Ctrl-C` stops both. Override the SPA port with `--port`.

## What you see

- **Overview** — cache stats cards (entries, total bytes, 24h hit
  rate, runs/24h) plus a list of recent invocations sorted by start
  time. Click a row → run detail.
- **Run detail** — per-task timeline (flamegraph), one lane per
  project, bars colored by status / cache source, plus the task
  table.

A **connection picker** in the top-right shows the current server
origin and a status dot. Click to paste a different URL and the
SPA reconnects — `http://localhost:4321` for another local server,
or `https://vx.your-company.com` for a hosted one.

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
   │ vx serve (Bun.serve)        │
   │  • /v1/* JSON over cache.db │
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

The SPA is platform-agnostic — every read is an HTTP call to a
configurable origin. Same JSON shape locally or hosted.

## HTTP surface

`vx serve` exposes a small JSON API:

| Path | Returns |
| --- | --- |
| `GET /health` | `ok` |
| `GET /version` | `{ vx, protocol, workspace, channels, rpc }` |
| `GET /v1/runs?project=&task=&runId=&limit=` | per-task run rows |
| `GET /v1/invocations?limit=` | grouped per `runId` |
| `GET /v1/runs/:runId` | full run detail + tasks |
| `GET /v1/cache/stats` | entry count, size, 24h hit rate |
| `GET /v1/history?project=&task=&limit=` | per-task rollups + p50/p99 |
| `GET /v1/explain/:taskId` | latest cache-key entry for a task |
| `GET /v1/why/:runId/:taskId` | compare hash with previous run |
| `GET /events`, `GET /v1/events` | SSE stream of run events |

All routes ship `Access-Control-Allow-Origin: *` — the hosted SPA
must be able to reach localhost from a foreign origin.

## Host the SPA once, point it anywhere

Build `apps/insights/` once, deploy the static `dist/` to any
host. Users open it, paste their `vx serve` origin into the
connection picker, and the SPA does its thing. Browsers allow
HTTPS pages to call `http://localhost:*` per the Secure Context
exception, so a hosted `https://insights.example.com` can read
from a local `vx serve` running on `http://localhost:4321`.

This is the "Cloud" model — but the cloud is just a deployment
of `vx serve` (in Docker, on a VM, anywhere). No separate stack,
no Cloudflare Workers, no D1.

## Privacy

When you run `vx insights` locally, nothing leaves your machine.
A hosted SPA pointed at `http://localhost:*` is also entirely
local — the picker is just configuration; the page reads from
your machine, not a third party.

## Known limits

- **No real-time view yet.** SSE event streaming exists on the
  server (`/v1/events`) but the SPA doesn't subscribe yet. Reload
  to see new runs.
- **No auth.** vx serve binds to localhost by default; trust is by
  network reachability. Add a reverse proxy with auth for hosted
  deployments.

See also: [`Self-hosting`](/vx/guides/self-hosting/),
[`Wire protocol`](/vx/guides/wire-protocol/).
