---
title: Dashboard
description: A Solid SPA embedded in the vx-cloud binary, fed by the cloud() plugin's telemetry push. Spawn + queue runs, watch them live, run history, cache-key diffs — token-authed, nothing to build.
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

## Quick start (local loop)

Declare the plugin once in your workspace's `vx.workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({ plugins: [cloud()] })
```

Then start the serve and connect to it ONCE:

```sh
vx-cloud serve --ui --open
vx-cloud connect http://localhost:4321
```

That:

1. boots the service on `http://127.0.0.1:4321` (a stable default
   port — the URL is the same across restarts, which is what makes the
   one-time connect stick),
2. serves the embedded dashboard at `/`, opening your browser at the
   same origin,
3. persists the connection per-user — **every subsequent `vx run` on
   the machine pushes its summary there** and shows up on the
   dashboard.

`vx-cloud connect` is the ONLY client↔serve wiring — a serve is never
auto-detected, so a running serve can't capture runs unless you
connected to it (`vx-cloud disconnect` stops the pushes). `Ctrl-C`
stops the serve. Drop `--open` to skip the browser launch; drop `--ui`
to run the API + streams headless.

Pin a different port with `--port 5000` or `VX_CLOUD_PORT=5000` (and
connect to that URL instead).

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

The landing page is **Runs** — the one surface for spawning, watching,
and digging into runs.

Key surfaces (Runs, Workspace, Cache, Artifacts, Insights) **auto-refresh
live** on a ~5s interval, so new runs and metrics appear without a manual
reload. A **live** pill in the header shows when auto-refresh is running;
it reads **paused** and the interval suspends while the tab is in the
background (refetching at once when you return). Previously-loaded data
stays on screen during a refresh — only the first load shows a skeleton.

- **Runs** (`/runs`) — the daily-dev entry point. A **spawn bar**
  submits runs against the serve's colocated workspace (task names
  autocomplete from the workspace catalog); each press queues another
  job, so you can trigger several back-to-back — the serve's FIFO queue
  executes them one at a time. A **CI-health strip** sits atop the view:
  a row of status ticks for the last ~24 runs (green passed / red
  failed, newest on the right, each a link into its run) plus health
  tiles — pass rate (24h), flaky-task count, cache hit rate (24h), and
  non-hermetic-key count — tinted green/amber/red by threshold and
  linking to the entity that explains each. The **queued/live section**
  shows every job (yours and CLI-delegated ones) with its queue
  position; queued jobs can be canceled, and the running job expands
  inline into the live session: a staged DAG of the task graph with the
  critical path highlighted, per-node status + duration + CPU/RAM, a
  flamegraph toggle, and streamed logs. When a job finishes it flows
  into the **history table** below — every invocation with branch /
  commit / CI / tags columns, per-row links to run detail and compare.
  Above the table, **faceted filters** (result · branch · project ·
  commit) narrow the history and persist in the URL hash
  (`#/runs?result=failed&branch=main`, `#/runs?commit=<sha>` — a
  shortened SHA matches by prefix), so a filtered view is shareable and
  restores on load; active facets show as clearable chips with a
  *clear all* affordance, alongside the free-text filter.
  (Spawning needs a colocated workspace — the graph comes from a
  no-exec `planRun`; an analytics-only serve shows history only. The old
  `/run` cockpit route redirects here.)
- **Run detail** (`/runs/:id`) — the staged DAG and a flamegraph
  timeline, a per-task table (CPU + peak RSS + hash), and a **"why did
  this re-run?"** card that names the exact cache-key components that
  changed since the previous run. Select a task (click a flamegraph
  bar) to open its panel — including the task's **captured log tail**
  (the last 128 KiB of merged stdout+stderr), so you can read a failed
  task's output without leaving the browser. A task that was a cache
  hit shows the output from the run that actually produced it (resolved
  by hash); when the serve holds the task's artifact, a download link
  appears too.
- **Compare** (`/compare/:id`) — diff a run against its immediately
  previous invocation (per-task duration deltas, status/hash changes).
- **Workspace** (`/overview`) — the workspace entity page: the
  project/task **catalog** (read lock-first from `vx-lock.json`, live
  eval fallback, with a staleness hint when configs drifted since
  `vx lock`), server identity, and links into the other areas. Needs a
  colocated workspace for the catalog; degrades to identity-only on a
  remote serve.
- **Projects** (`/projects`, `/projects/:name`) — the catalog joined
  with run analytics, so **never-run projects have pages too**; a
  project's detail shows a **trend tile row** (this 7 days vs the
  prior 7, scoped to the project: avg exec, failure rate, runs, hit
  rate, each with a signed delta tinted by direction — "did MY
  project get faster or slower?") plus its resolved per-task config
  blocks.
- **Tasks** (`/tasks`, `/tasks/:id`) — catalog ∪ history: every
  declared task (group/persistent/cacheable kind) with per
  `(project, task)` aggregates — runs, success rate, hit rate,
  avg/p50/p99, a duration sparkline, a **per-task trend row** (this
  7d vs prior 7d with signed deltas — the "did my change slow this
  task down?" read), a **Debug card** with one-click jumps (the last
  *failed* run with this task's captured logs pre-opened, the latest
  run, and the latest artifact's cache-entry page with its download),
  the latest cache-key entry, the resolved **Config** card, a flaky
  badge when `/v1/flakiness` flags it, and a **Recommendations** card
  that turns the task's flaky / hermeticity / caching signals into
  concrete fixes (each with a copy-pasteable config snippet —
  `exec.retries`, a per-platform `cache.inputs.runtime` key split, or
  an `exec`/`cache` block for a slow uncached task).
- **Cache** (`/cache`, `/cache/:hash`) — hit-rate split (local vs
  remote), estimated time saved, per-project bytes, an entries
  inventory with cold/stale heat and reclaimable bytes, and a
  per-entry page (facts, the runs that produced/restored it, artifact
  download).
- **Artifacts** (`/artifacts`) — the `/v8` artifact store made
  visible: every artifact your token may read (trust-scoped), with
  size/age/tier, best-effort task/run provenance links, and
  bearer-authenticated downloads. Works on remote serves too.
- **Insights** (`/insights`) — the one analytics area. **Trending
  tiles** compare this 7-day window against the prior one (runs,
  failure rate, cache hit rate, average executed duration — signed
  deltas tinted by direction), and a **Biggest movers** table ranks
  the tasks whose average duration shifted most between the two
  windows (a mover needs ≥3 executions in *both* windows, so it's a
  trend, not noise). A **Started failing across branches** card names
  tasks whose most-recent run fails on ≥2 distinct branches — the
  "what just broke everywhere?" signal, with a red dot for a true
  regression (it used to pass) and amber for an always-broken task.
  Plus: run/storage trends, the build heatmap, bottlenecks with
  weekly-savings estimates, flaky tasks (with the within-run-retry
  **Retried** column and a **Suggested fix** column showing the
  `exec.retries: N` to add for confirmed-flaky tasks), the
  **Hermeticity** card (cross-machine output-fingerprint divergence
  from `vx run --force --verify=fingerprint` runs — the exact task,
  platforms, and diverging output files, with a remediation hint),
  cache savings + hit-source split, parallelism, top time-burners,
  and recent failures. Every row links into its entity — a failure
  opens its run with the task pre-selected. The old `/trends` and
  `/bottlenecks` routes redirect here.

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
| `GET /v1/artifacts` | list the `/v8` store (trust-scoped, task/run provenance) |
| `GET/PUT /v1/cache/:hash` | The vx-native remote-cache artifact store |
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

`vx-cloud serve` also hosts the vx-native artifact store at
`/v1/cache/:hash`. Connect the serve (`VX_CLOUD_URL` + token, or
`vx-cloud connect`) and one URL gives you both analytics and a remote
cache. See [`Remote caching`](/vx/guides/remote-caching/).

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

## Task logs: capture, storage, and privacy

Per-task log tails are captured by the `cloud()` plugin (default on
when connected) and shipped to the serve after each run's summary; a
serve executing a **delegated** run captures them itself. Storage is
bounded at every layer: the last 128 KiB per task, 4 MiB shipped per
run (a failed task's tail is never evicted to keep a successful one),
a 16 MiB request cap, and a per-workspace ceiling
(`VX_CLOUD_LOG_MAX_BYTES`, default 512 MiB) plus age retention
(`VX_CLOUD_LOG_RETENTION_DAYS`, default 30). Cache-hit tasks store
nothing — they resolve by hash to the run that produced the bytes.

**Privacy.** Log tails are program output and may echo secrets. This
is the same trust boundary the remote cache already crosses (a
cacheable success ships its full stdout to the same serve, under the
same bearer + trust scoping). Turn capture off with
`cloud({ logs: false })` or `VX_CLOUD_LOGS=0`.

## Known limits

- **Analytics-only stores.** The serve reads run/task history from its
  ingest store, not a workspace `cache.db`, so the cache-entry
  inventory (heat, reclaimable bytes) is only populated where entry
  data is available.
- **Distributed runs have no persisted history yet.** A distributed
  (`VX_CLOUD_DISTRIBUTE`) run relays its output live but does not yet
  ingest a run summary, so it does not appear under Runs and its logs
  are not persisted (Phase 2 of the task-logs design).
- **History resets on a schema bump.** The ingest store shares core's
  pre-alpha "drop and recreate on `SCHEMA_VERSION` change" policy;
  snapshot the ingest volume before upgrading `vx-cloud` to keep
  history across schema bumps (the serve warns loudly when this
  happens).

See also: [`Self-host vx-cloud`](/vx/guides/self-hosting/),
[`vx-cloud serve wire protocol`](/vx/guides/wire-protocol/),
[`Distributed CI execution`](/vx/guides/distributed-ci/).
