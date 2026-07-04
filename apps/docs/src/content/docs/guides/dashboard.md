---
title: Dashboard
description: A Solid SPA embedded in the vx-cloud binary, fed by the cloud() plugin's telemetry push. Run history, live cockpit, cache-key diffs — token-authed, nothing to build.
---

The dashboard is the UI of **`@vzn/vx-cloud`**, the standalone
orchestrator service. It ships **inside the compiled `vx-cloud`
binary** — pass `--ui` to `vx-cloud serve` and the same process that
serves the metrics API also serves the dashboard at `/`. There is no
asset directory on disk and nothing for you to build: the SPA is
embedded in the executable (a released binary or the Docker image
already carries it).

It is served by `vx-cloud serve`, **not** `vx serve` — the dashboard
belongs to the service package, and core `vx` has no server commands.

## Where the data comes from

The dashboard reads **only the serve's own SQLite ingest store**. It
never opens a workspace `cache.db`. Runs land in that store one way:
the [`cloud()` plugin](/vx/guides/plugins/) pushes each `vx run`'s
summary to `POST /v1/ingest`. So a run appears on the dashboard **only
after a `cloud()`-enabled `vx run` pushes it** (or a run delegated to
the serve self-ingests). A fresh serve with no pushes shows an empty
dashboard — that's expected, not a bug.

Because the serve reads only its own store, `vx-cloud` can run anywhere
— on your laptop next to the workspace, or on a remote box that has no
access at all to the machines that produced the runs.

## Quick start (zero-config local loop)

Declare the plugin once in your workspace's `vx.workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({ plugins: [cloud()] })
```

Then start the serve in (or anywhere reachable from) your workspace:

```sh
vx-cloud serve --ui --open
```

That:

1. boots the service on `http://127.0.0.1:4321` (a stable default
   port — the URL is the same across restarts),
2. serves the embedded dashboard at `/`,
3. opens your browser at the same origin.

The `cloud()` plugin auto-detects the local serve through its per-user
advertisement, so **every subsequent `vx run` pushes its summary with
no further config** and shows up on the dashboard. `Ctrl-C` stops the
serve. Drop `--open` to skip the browser launch; drop `--ui` to run the
API + streams headless.

Pin a different port with `--port 5000` or `VX_CLOUD_PORT=5000`.

## Authentication

The serve binds `127.0.0.1` by default, so an unauthenticated instance
is only reachable from the local machine. For anything else:

- **`--token <t>` / `VX_CLOUD_TOKEN`** — requires
  `Authorization: Bearer <t>` on every request except `/health` and
  `/v1/meta`. Browser transports that can't set headers (EventSource,
  WebSocket) may pass `?token=` instead. The UI has a token field in
  its header; paste the token once and it's remembered.
- **Non-loopback bind** (e.g. `--host 0.0.0.0` for a hosted
  deployment) **requires** a token — the serve refuses to start
  otherwise, because the run/agent WebSocket channels execute arbitrary
  workspace tasks.
- **Cross-origin WebSocket / SSE handshakes are Origin-checked.**
  Same-origin and non-browser (CLI) clients always pass; any other
  cross-origin browser handshake is refused unless you allow-list its
  origin with `--allow-origin <o>` (repeatable) or
  `VX_CLOUD_ALLOW_ORIGIN` (comma-separated). This is drive-by-RCE
  (CSWSH) defense.

A **connection / server picker** in the dashboard header shows the
current origin and a status dot. Click it to point the SPA at a
different `vx-cloud serve` (another local instance, or a hosted
`https://vx.your-company.com`) and it reconnects.

## Multiple workspaces on one serve

A single serve can hold many workspaces. Each has a stable id derived
from its git remote, and each gets its own store under
`<ingest-dir>/<workspaceId>/`. The dashboard has a **workspace
switcher** (hidden when only one workspace exists); every analytics
route scopes to the selected workspace via `?ws=<id>`. An un-scoped
request resolves to the sole workspace when there's exactly one, so a
single-repo serve behaves exactly like a single-workspace one.

## What you see

The landing page is capability-aware: a serve colocated with a
workspace opens on the **Cockpit**; an analytics-only serve opens on
**Runs**.

- **Cockpit** (`/run`) — the daily-dev entry point. Submit and watch a
  run live over the WebSocket: a staged DAG of the task graph with the
  critical path highlighted, per-node status + duration + CPU/RAM, and
  streamed logs. (Needs a colocated workspace — the graph comes from a
  no-exec `planRun`.)
- **Runs** (`/runs`) — every invocation, with branch / commit / CI /
  tags columns; rows link to run detail.
- **Run detail** (`/runs/:id`) — the staged DAG and a flamegraph
  timeline, a per-task table (CPU + peak RSS + hash), and a **"why did
  this re-run?"** card that names the exact cache-key components that
  changed since the previous run.
- **Compare** (`/compare/:id`) — diff a run against its immediately
  previous invocation (per-task duration deltas, status/hash changes).
- **Tasks** (`/tasks`, `/tasks/:id`) — per `(project, task)`
  aggregates: runs, success rate, hit rate, avg/p50/p99, a duration
  sparkline, and the latest cache-key entry.
- **Cache** (`/cache`) — hit-rate split (local vs remote), estimated
  time saved, per-project bytes, and an entries inventory with
  cold/stale heat and reclaimable bytes.
- **Trends** (`/trends`), **Projects** (`/projects`),
  **Bottlenecks** (`/bottlenecks`), **Overview** (`/overview`) — run
  and storage trends, a run heatmap, project rollups, and the top
  time-burners.

## How it works

```
  your workspace                       vx-cloud serve --ui
  ┌────────────────────┐   POST         ┌─────────────────────────────┐
  │ vx run             │   /v1/ingest   │ Bun.serve (127.0.0.1:4321)  │
  │  cloud() plugin ───┼───────────────▶│  • POST /v1/ingest          │
  │  pushes summary    │  RunSummary    │  • /v1/* metrics JSON        │
  └────────────────────┘                │  • embedded SPA at /         │
                                        │  • token auth + Origin gate  │
  Browser                               └───────────────┬─────────────┘
  ┌────────────────────┐  GET /v1/runs,…               │ bun:sqlite
  │ dashboard SPA      │◀──────────────                ▼
  │  (embedded, token  │                 ┌─────────────────────────────┐
  │   + server picker) │                 │ ingest store (SQLite)       │
  └────────────────────┘                 │  <ingest-dir>/<wsId>/…      │
                                         └─────────────────────────────┘
```

The dashboard builds to a single self-contained `index.html` (JS + CSS
inlined), which the binary embeds via Bun's `with { type: 'file' }`. A
compiled `vx-cloud` carries it with nothing else on disk.

The ingest store defaults to `<workspaceRoot>/.vx/cloud-ingest`; point
it at a persistent volume for a hosted deployment with
`--ingest-dir <d>`.

## HTTP surface

`vx-cloud serve` exposes (analytics routes take an optional `?ws=<id>`):

| Path | Returns |
| --- | --- |
| `GET /health` | `ok` (unauthenticated) |
| `GET /v1/meta` | server identity + capabilities (pre-auth) |
| `GET /version` | protocol version, channels, RPC list, workspace |
| `POST /v1/ingest` | push a `RunSummaryRecord` (the plugin's endpoint) |
| `GET /v1/workspaces` | known workspaces (id, name, run count) |
| `GET /v1/runs` | per-task run rows (`project`/`task`/`runId`/`limit`) |
| `GET /v1/invocations` | invocations (branch / ci / tag filters) |
| `GET /v1/runs/:id` | full run detail + tasks |
| `GET /v1/compare/:id` | diff a run vs its previous invocation |
| `GET /v1/graph?tasks=` | task DAG + predicted cache status (colocated) |
| `GET /v1/cache/stats` | entry count, size, 24h hit rate |
| `GET /v1/cache/hit-split` | local vs remote hit split |
| `GET /v1/cache/entries` | entries inventory |
| `GET /v1/history` | rollups with p50/p99 |
| `GET /v1/explain/:taskId` | latest cache-key entry |
| `GET /v1/why/:runId/:taskId` | compare a task's hash with its previous run |
| `GET /v1/diff/:runId/:taskId` | per-component cache-key diff |
| `GET /events`, `GET /v1/events` | SSE stream of run events |
| `GET /stream` | NDJSON stream of run events |
| `POST /mcp` | MCP endpoint (JSON-RPC 2.0) for AI agents |
| `GET/PUT /v8/artifacts/:hash` | Turbo-wire remote cache artifact store |
| `WS /` | delegated run submission |
| `WS /v1/agents` | distributed-execution agent rendezvous |

(Trends, bottlenecks, top-tasks, failures, and projects routes exist
under `/v1/*` too — the dashboard calls them directly.)

## MCP: the same serve, for AI agents

The serve exposes `POST /mcp` — a dependency-free MCP endpoint
(JSON-RPC 2.0) behind the same bearer token. AI agents connect to any
`vx-cloud serve`, local or remote, and query the same metrics the
dashboard shows. See [`vx mcp — AI agents`](/vx/guides/mcp/).

## Remote cache, in the same process

`vx-cloud serve` also hosts a Turbo-wire artifact store at
`/v8/artifacts/:hash`. Point core's `VX_REMOTE_CACHE_URL` (or a
connected environment) at the serve and one URL gives you both
analytics and a remote cache. See
[`Remote caching`](/vx/guides/remote-caching/).

## Hosting the SPA separately (advanced, optional)

You never need to build the SPA to use the dashboard — the picker plus
the embedded build cover every case. But because the dashboard is a
single static `index.html` and the connection picker can aim it at any
reachable serve, you *can* host that one file on any static host and
point it at a `vx-cloud serve`. Browsers allow an HTTPS page to call
`http://localhost:*` (the Secure Context exception), so a hosted
`https://dash.example.com` reading from a local `http://localhost:4321`
works. (Contributors can rebuild the embedded bundle from
`packages/cloud/ui` — that's a source-checkout concern, not a usage
step.)

## Known limits

- **Analytics-only stores.** The serve reads run/task history from its
  ingest store, not a workspace `cache.db`, so the cache-entry
  inventory (heat, reclaimable bytes) is only populated where entry
  data is available.
- **History resets on a schema bump.** The ingest store shares core's
  pre-alpha "drop and recreate on `SCHEMA_VERSION` change" policy;
  snapshot the ingest volume before upgrading `vx-cloud` to keep
  history across schema bumps (the serve warns loudly when this
  happens).

See also: [`Self-host vx serve`](/vx/guides/self-hosting/),
[`vx serve wire protocol`](/vx/guides/wire-protocol/),
[`Distributed CI execution`](/vx/guides/distributed-ci/).
