# Dashboard — design

> **Status: proposed.** No code yet. Closes the loop from "we have run
> history in SQLite" (PR #7) and "we have a remote cache server"
> (PR #10–13) to "you can actually see what your workspace is doing."
> Two deployment modes: local `vzn dashboard` and a one-button
> Cloudflare deploy. Same UI bundle, same HTTP API, two data backends.

## What we're solving

`vzn stats` prints four numbers. That's useful, but the v10 schema is
already capturing every task execution in a queryable table and the
remote-cache server is a natural aggregation point for a fleet. There
is no reason a developer who runs `vzn run build` 50 times a day can't
see:

- Which tasks are slowest, flakiest, most-invalidated.
- Run velocity over time and cache hit rate by day.
- A flamegraph of every task in a given run, with cache-hit overlay.
- What's actually in their cache and what should be pruned.

That's the NX Cloud pitch, minus the lock-in. We ship the same value
locally (zero config, opens in your browser) and as a one-button
Cloudflare deploy when a team wants shared visibility.

## TL;DR

- **One UI bundle** (vanilla HTML + Alpine.js + d3-flame-graph) served
  by two backends behind the same JSON API.
- **Local backend** is a Bun.serve() over `.vzn/cache/cache.db`,
  started by `vzn dashboard`. Loopback only; no auth.
- **Cloud backend** is a Cloudflare Worker over D1, deployed via a
  "Deploy to Cloudflare" button from a `cf-dashboard/` template. Bearer
  auth, same token as the remote cache.
- **Ingestion** for the cloud variant: `vzn run` pushes run-history
  rows to the Worker's `/api/ingest/runs` endpoint. Reuses the existing
  `VZN_REMOTE_CACHE_TOKEN`. No new server-side write path.
- **Schema additions**: per-task `cpu_ms`, `peak_rss_bytes`,
  `wallclock_started_at_ns`, `wallclock_ended_at_ns`, `cache_hit`,
  `bytes_uploaded`, `bytes_downloaded`. Added to the existing `runs`
  table; nothing in `entries` changes.

## Goals & non-goals

### Goals (v1)

1. Local-first, zero-config dashboard that opens in a browser when a
   developer types `vzn dashboard`.
2. Flamegraph of a single run showing every task's wall-clock span,
   colored by status, with CPU/memory overlay on hover.
3. Five canonical pages (Overview, Tasks, Runs, Run detail, Cache).
4. Identical JSON API surface in local + cloud, so the static bundle
   ships once.
5. One-button Cloudflare deploy of the same UI against a D1-backed
   Worker, with ingestion from `vzn run`.

### Non-goals (v1)

- Multi-user, auth-z, RBAC. Single shared bearer token in the cloud
  variant; trust everyone with the token equally.
- Comparison views (run A vs run B, branch A vs branch B). Tractable
  but expands scope significantly.
- Retention policies on the cloud side. The Worker writes; pruning is
  manual `wrangler d1 execute` for now.
- Alerts, webhooks, Slack/Discord integrations.
- Mobile-optimized UI. Desktop-first; pages must not break on a phone
  but no separate layouts.
- Per-file CPU profiling, V8-tick samples, eBPF spans. The "flamegraph"
  is at task granularity, not function granularity.
- Historical re-ingest. Once a `vzn run` finishes, that's the only
  chance to push to D1. No backfill from local DB.

## Data model

The `entries` table is untouched. The `runs` table grows; every new
column is nullable so the migration is a single `ALTER TABLE`.

```sql
ALTER TABLE runs ADD COLUMN cpu_ms                INTEGER;
ALTER TABLE runs ADD COLUMN peak_rss_bytes        INTEGER;
ALTER TABLE runs ADD COLUMN wallclock_start_ns    INTEGER;  -- monotonic, run-relative
ALTER TABLE runs ADD COLUMN wallclock_end_ns      INTEGER;
ALTER TABLE runs ADD COLUMN cache_hit             INTEGER;  -- 0/1; status alone is ambiguous
ALTER TABLE runs ADD COLUMN bytes_uploaded        INTEGER;  -- to remote cache, this run
ALTER TABLE runs ADD COLUMN bytes_downloaded      INTEGER;  -- from remote cache, this run
ALTER TABLE runs ADD COLUMN run_id                TEXT;     -- groups tasks into a single `vzn run`

CREATE INDEX runs_run_id ON runs(run_id);
```

`run_id` is a ULID generated once per `vzn run` invocation (in
`orchestrator.run`, before scheduling). It threads through every
`recordRun` call so we can group "all tasks from this invocation" into
the flamegraph without parsing timestamps.

`wallclock_start_ns` / `wallclock_end_ns` are nanoseconds **relative
to the run's t=0**, using `process.hrtime.bigint()`. The Y-axis of
the flamegraph wants run-relative monotonic time, not wall-clock —
wall-clock drifts and doesn't compose across runs.

### Where each field is captured

| Field                       | Captured in                       | Source                                                       |
| --------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `cpu_ms`                    | `runner.runCommand` after `close` | `proc.cpuUsage()` — sum of user + system from rusage         |
| `peak_rss_bytes`            | `runner.runCommand` after `close` | Linux: `getrusage(RUSAGE_CHILDREN)`. macOS: same. Bun wraps. |
| `wallclock_start/end_ns`    | `orchestrator.executeTask`        | `process.hrtime.bigint()` deltas vs run start                |
| `cache_hit`                 | `orchestrator.executeTask`        | 1 when we returned from a cache hit, 0 otherwise             |
| `bytes_uploaded/downloaded` | `layered-cache.ts`                | Sum bytes from successful PUT/GET in this task               |
| `run_id`                    | `orchestrator.run`                | ULID, once per invocation                                    |

`runner.RunResult` grows two fields (`cpuMs`, `peakRssBytes`).
`sandbox.runSandboxed` already wraps `runCommand`, so it inherits the
capture automatically. The orchestrator threads `runId` and the start
nanosecond offset into `recordRun`.

CPU and RSS are best-effort. Bun ≥ 1.3 exposes child rusage on Linux
and macOS via `Bun.spawn`'s `resourceUsage` callback; on Windows we
write NULLs. Nullable schema, graceful UI degradation.

## Two deployment modes

### Local: `vzn dashboard`

```
vzn dashboard [--port N] [--no-open] [--host HOST]
```

- Boots `Bun.serve()` on `127.0.0.1:<port>` (default `7421`,
  deterministic for bookmarkability).
- Opens `http://localhost:7421` in the user's browser by default; pass
  `--no-open` to skip. Browser open uses `open` on macOS, `xdg-open`
  on Linux, `start` on Windows, via `Bun.spawn` — failure is a warning,
  not fatal.
- Reads `.vzn/cache/cache.db` via the existing `Cache` class (in
  read-only mode — `new Database(path, { readonly: true })`). No
  writes from the dashboard process ever.
- Serves the static UI bundle from inside the published package
  (`dist/dashboard/*` shipped with `@vzn/run`).
- Zero config. If the user isn't inside a workspace, exits 1 with a
  clear error ("no `.vzn/cache/cache.db` found in this directory or
  any ancestor").

The implementation lives in `src/dashboard/server.ts`. Roughly 200
LOC: route table, handlers, static-file middleware, browser-open shim.

### Cloudflare: `cf-dashboard/` template

A new top-level directory `cf-dashboard/` in the monorepo holds the
deployable template:

```
cf-dashboard/
├── wrangler.toml
├── schema.sql           # D1 schema (mirrors local `runs` + `entries`)
├── src/
│   └── worker.ts        # Cloudflare Worker; same HTTP API as local
├── public/              # static UI bundle (same as local ships)
└── README.md            # one-button deploy + manual deploy instructions
```

The Worker:

- Routes `GET /api/*` to D1 queries.
- Routes `POST /api/ingest/runs` to a D1 insert (bearer-token gated).
- Serves `public/*` via the Workers static-assets binding (no separate
  Pages project; one `wrangler.toml`).
- Uses Workers KV (optional) for a tiny TTL cache on the `/api/overview`
  endpoint, since it aggregates and is hit often.

The schema mirrors local SQLite verbatim except `INTEGER PRIMARY KEY
AUTOINCREMENT` becomes `INTEGER PRIMARY KEY` (D1 supports rowid by
default). One file, no per-column dialect drift.

## Ingestion for the cloud variant — push, not pull

**Decision: push.** `vzn run` POSTs new `runs` rows to the Worker's
`/api/ingest/runs` endpoint after the run finishes.

Rationale:

- **The remote cache server is not ours.** A user might point
  `VZN_REMOTE_CACHE_URL` at `ducktors/turborepo-remote-cache`,
  `Fox32/openturbo-remote-cache`, or Vercel's hosted cache. None of
  those have our run history. The pull model assumes we own the cache
  server — we explicitly chose not to in PR #10.
- **The dashboard Worker is single-purpose.** It owns its D1. No
  shared schema with whatever cache backend is in use.
- **Push is one HTTP call per run, not per task.** The CLI batches
  every task's `RunRecord` into one POST body. ~5KB for a 100-task
  workspace. Fire-and-forget; failures don't break the build.
- **Multiple cache configurations stay independent.** A team could
  point at Vercel's hosted Turbo cache (no run-history concept) AND
  push run history to their own dashboard Worker.

Configuration:

| Env var                    | Required? | Notes                                                         |
| -------------------------- | --------- | ------------------------------------------------------------- |
| `VZN_DASHBOARD_URL`        | yes       | Base URL of the dashboard Worker.                             |
| `VZN_DASHBOARD_TOKEN`      | yes       | Bearer token. Distinct from remote-cache (different surface). |
| `VZN_DASHBOARD_TIMEOUT_MS` | no        | Per-POST timeout. Default `5000`. Fail = drop, never block.   |

Distinct token from remote-cache because the surfaces have different
trust profiles: a remote-cache token can read/write artifacts;
a dashboard token can read run history. A team may want to expose one
without the other.

Rejected: piggybacking on the remote cache's `POST /v8/artifacts/events`
endpoint. That's Turbo's telemetry hook; semantics don't match (event
log, not row inserts) and we'd be coupling to a spec we don't own.

## UI pages

Five pages. Single SPA shell, hash-routed (`#/overview`, `#/runs/:id`).

### Overview (`#/overview`)

- Big-number cards: entry count, total cache size, runs (24h),
  hit-rate (24h).
- Sparklines: runs/day for last 30 days, hit rate by day, bytes
  uploaded/downloaded by day (cloud variant only).
- "Recent failures" list (last 5 failed tasks, click into the run).

### Tasks (`#/tasks`)

- Sortable table of every distinct `(project, task)` pair.
- Columns: task ID, invocation count (30d), median wall-clock,
  median CPU, p95 wall-clock, hit rate, last run.
- Quick filters: "slowest", "most-invalidated" (lowest hit rate),
  "most-cached" (highest hit rate).
- Click a row to filter Runs page to just that task.

### Runs (`#/runs`)

- Reverse-chronological table of `vzn run` invocations grouped by
  `run_id`.
- Columns: run ID (short ULID), started, total wall-clock, task
  count, success/fail/cache-hit breakdown, total CPU.
- Pagination: `?since=&limit=`, infinite-scroll up to a server cap
  of 1000.

### Run detail (`#/runs/:id`)

- Header: run ID, started timestamp, total wall-clock, task counts.
- **Flamegraph** as the centerpiece. See "Flamegraph rendering."
- Sortable task table below the graph.
- Cache stats sidebar: bytes uploaded/downloaded for this run.

### Cache (`#/cache`)

- Sortable table over `entries`: hash (truncated), project, task,
  size, age (created_at), last access, command.
- Filters: project, task, size threshold, age threshold.
- "Prune candidates" computed view: oldest 100 entries with size,
  cumulative-size column for "evict to free X bytes."
- Read-only. We do not expose a delete button in v1 — `vzn cache
prune` is the supported path. The dashboard is a visualizer.

## UI tech stack

**Pick: vanilla HTML + Alpine.js + d3 (for flamegraph) served as
static files. No build step.**

- Alpine.js gives us `x-data` / `x-for` / `x-show` directives for tiny
  reactive islands. Single 15KB UMD script.
- d3 is loaded for the flamegraph and sparklines only, lazy-fetched on
  the pages that need it.
- Pages are static `.html` files that fetch JSON and template into the
  DOM. The "router" is hash-fragment matching in a 30-line script.
- No bundler. No JSX. No npm install on the user's side. The published
  `@vzn/run` package ships `dist/dashboard/` as plain files; the
  Worker ships `public/` identically.

Rejected:

- **Solid / Preact**: still requires a build step to be ergonomic
  (JSX) or sacrifices DX without one. The HTML+Alpine path is half the
  setup and the dashboard surface is small enough that we don't need
  fine-grained reactivity.
- **React**: too heavy; we don't need its ecosystem and the no-build
  story is awkward.
- **htmx**: appealing, but it expects server-rendered HTML fragments,
  which forces the API to be dual-format (JSON for `/api/*`, HTML for
  htmx swaps). Doubles the surface.

Trade-off accepted: the UI ceiling is lower. If we ever want
drag-to-zoom on the flamegraph or a complex comparison view, we'll
reach for Preact (no JSX, just `htm`) without rewriting the API.

## Flamegraph rendering

**Pick: d3-flame-graph (Brendan Gregg's classic, npm: `d3-flame-graph`,
~30KB).**

- It accepts a flat array of spans with `start`, `end`, `parent` —
  exactly our shape.
- X-axis = wall-clock since run start (from `wallclock_start_ns`).
- Y-axis = parallelism lane — assigned greedily by the API (first row
  walks tasks sorted by start time, packs each into the lowest lane
  whose previous span has ended).
- Color encoding by status: green = success, yellow = cache-hit,
  red = failed, gray = skipped.
- Hover tooltip shows: task ID, wall-clock duration, CPU ms, peak RSS,
  cache hit yes/no, bytes uploaded/downloaded.
- **CPU/memory overlay**: a thin secondary bar inside each span's
  rectangle, width proportional to `cpu_ms / wallclock_ms`. A bar
  near full width means the task was CPU-bound; a thin sliver means
  it was waiting (network, disk, child processes). RSS shows as a
  small badge inside the span.

Rejected:

- **speedscope-embed**: solves a different problem (function-level
  sampled profiles, not task-level spans). Wrong granularity.
- **Hand-rolled SVG**: would be ~150 LOC. Tempting, but d3-flame-graph
  has years of usability tuning (zoom, search, fuzzy match) that
  rewriting throws away.

## API design

Identical surface for local + cloud. The bundle calls the same URLs.

```
GET  /api/overview
       → { entryCount, totalBytes, runs24h, hits24h,
           runsPerDay: [{ day, runs, hits }], failures: [...] }

GET  /api/runs?since=<ms-epoch>&limit=<n>
       → { runs: [{ runId, startedAt, endedAt, taskCount,
                    successes, failures, cacheHits, totalCpuMs }] }
       Default limit 50, max 1000.

GET  /api/runs/:runId
       → { runId, startedAt, endedAt,
           tasks: [{ project, task, status, exitCode,
                     wallclockStartNs, wallclockEndNs,
                     cpuMs, peakRssBytes, cacheHit,
                     bytesUploaded, bytesDownloaded }] }

GET  /api/tasks/slowest?days=<n>&limit=<n>
       → { tasks: [{ project, task, p50ms, p95ms, count }] }

GET  /api/tasks/aggregates?days=<n>
       → { tasks: [{ project, task, count, p50ms, p95ms,
                     hitRate, lastRunAt }] }

GET  /api/cache/entries?sort=<size|created|accessed>&limit=<n>
       → { entries: [{ hash, project, task, sizeBytes,
                       createdAt, accessedAt, command }] }

POST /api/ingest/runs    (cloud only)
       Authorization: Bearer <token>
       Body: { runId, startedAt, endedAt,
               runs: [<RunRecord>...] }
       → 200 with { inserted: N } or 401/400.
```

The local server returns 405 for `POST /api/ingest/runs` — local has
no ingestion concept; the orchestrator writes the SQLite directly.

## Authentication

**Local**: bind to `127.0.0.1` only. Loopback is trusted; we don't
listen on `0.0.0.0` by default. A `--host` flag exists for "I'm on a
remote machine and want to tunnel" but prints a `WARNING: binding
non-loopback host; this exposes your run history` line. No auth at all
on the local server.

**Cloud**: bearer token in `Authorization: Bearer <token>`. Token is
read from the Worker secret `DASHBOARD_TOKEN` (set with `wrangler
secret put`). Same token used for `VZN_DASHBOARD_TOKEN` on the
client. Single token gates both reads and writes; v1 doesn't
distinguish, by design.

CORS: `Access-Control-Allow-Origin: *` on read endpoints (so people
can curl from anywhere), `*` on `/api/ingest/runs` with the bearer
token as the actual gate. We deliberately don't mix CORS with auth.

## One-button Cloudflare deploy

The deploy URL pattern, per Cloudflare's docs:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<org>/<repo>/tree/main/cf-dashboard
```

The button lives in the project README and in `cf-dashboard/README.md`.
It points at the `cf-dashboard/` subdirectory of this monorepo. Clicking:

1. Clones the subdirectory to the user's GitHub account.
2. Provisions a new Worker bound to a new D1 database.
3. Reads `wrangler.toml` to set up bindings (D1, static assets, optional
   KV).
4. Runs `wrangler d1 execute --file=schema.sql` to create tables.
5. Prompts for `DASHBOARD_TOKEN` (Worker secret).
6. Deploys.

End state: the user has a URL like `https://<random-slug>.workers.dev`,
a token, and they paste both into their CI as
`VZN_DASHBOARD_URL`/`VZN_DASHBOARD_TOKEN`. CI runs send rows; they
open the URL.

Required files in `cf-dashboard/`:

- `wrangler.toml` — name, main, compatibility_date, d1_databases
  binding, assets binding.
- `schema.sql` — `CREATE TABLE runs ...; CREATE TABLE entries ...;`
  matching v10 plus the dashboard additions.
- `src/worker.ts` — `fetch(req, env)` handler with the route table.
- `public/index.html` and friends — the same UI bundle the published
  `@vzn/run` package ships in `dist/dashboard/`. A pre-publish step
  copies it from `src/dashboard/static/` into both locations.

## Implementation order

Smallest viable PR first. Each PR independently mergeable and adds
value on its own.

**PR 1 — schema additions.** `ALTER TABLE runs ADD COLUMN ...`. Bump
`SCHEMA_VERSION` from `v10` to `v11`. Wipe-and-recreate on mismatch
(pre-alpha). Tests assert the new columns exist. No new behavior yet.

**PR 2 — capture CPU + RSS in `runner.runCommand`.** Extend `RunResult`
with `cpuMs` and `peakRssBytes`. Surface via `getrusage` / Bun's
`resourceUsage` callback. Plumb through `executeTask` → `recordRun`.
Tests cover Linux + macOS; Windows asserts NULLs.

**PR 3 — `run_id` + wall-clock nanoseconds.** Generate a ULID per
`vzn run` in `orchestrator.run`. Thread through to `recordRun`. Use
`hrtime.bigint()` for start/end relative to run start. Tests verify
all tasks of one run share a `run_id`.

**PR 4 — `vzn dashboard` local server.** New `src/dashboard/server.ts`,
Bun.serve over the existing `Cache` class (read-only). Implements the
full `/api/*` surface. Tests use `fetch` against the spawned server.
No UI yet — surface verified via JSON.

**PR 5 — UI bundle: Overview + Cache pages.** Static HTML/Alpine
under `src/dashboard/static/`. Wire to the two read endpoints. The
two simplest pages first. Smoke test: serve, fetch `/`, parse, assert
key DOM nodes exist.

**PR 6 — UI: Tasks + Runs pages.** Add the aggregate endpoints and
the run-list view.

**PR 7 — UI: Run detail page + flamegraph.** Add d3-flame-graph;
implement lane-packing in the `/api/runs/:id` response (server-side
so the UI is dumb).

**PR 8 — `cf-dashboard/` template.** New top-level directory. Worker

- D1 + static-assets binding. Schema SQL. README with the Deploy
  button. Runs the same UI bundle.

**PR 9 — Push ingestion from `vzn run`.** When
`VZN_DASHBOARD_URL` + `VZN_DASHBOARD_TOKEN` are set, POST the run's
records after `orchestrator.run` finishes. Fire-and-forget; logs a
warning on failure. CLI flag `--no-dashboard` to opt out per
invocation.

**PR 10 — Docs.** `docs/dashboard.md` user guide; `docs/cli.md`
entry for `vzn dashboard`; `docs/architecture.md` cluster update;
CLAUDE.md decision log.

## What's out of scope for v1

- **Multi-user / teams / RBAC.** Single token, single trust level.
- **Per-branch comparison.** A killer feature but doubles the data
  model (need to capture branch + commit per run).
- **Retention policies on D1.** `cf-dashboard` accumulates rows forever
  until the user manually prunes. D1's free tier is generous enough
  that this won't bite for months.
- **Alerts / webhooks / Slack.** Push notifications need an event
  loop the Worker doesn't have; defer until users ask.
- **Mobile UI.** Pages must not visually shatter on a phone, but no
  dedicated layouts.
- **Comparison views.** Run-vs-run diff, branch-vs-branch trendlines.
  Real product work; not v1.
- **Function-level profiling.** The flamegraph is at task granularity.
  Bringing in V8 profiles, eBPF samples, or perf data is a separate
  capture pipeline.
- **Self-hosted-anywhere binary.** Cloud deploy is Cloudflare-only in
  v1. A generic Docker image of the Worker (via `workerd`) is
  tractable but not needed yet.
- **Backfill from local DB to cloud.** Once a run finishes without
  pushing, those rows stay local-only forever. No `vzn dashboard
push` command in v1.
- **Live updates.** No WebSocket / SSE. Page-refresh is the supported
  way to see new data. Adding SSE later is one endpoint and a 20-line
  client.

## Why this is the right move

- **Closes the v10 loop.** We captured run history in PR #7 for
  exactly this. Without a viewer, the data is dead.
- **No new heavy deps.** Alpine + d3 + d3-flame-graph total under
  60KB. Bun.serve is built in. `bun:sqlite` already in use.
- **Pre-alpha-friendly cloud story.** "Click a button, get a URL" is
  the right onboarding for a team trying us out. Self-hosting a
  Node-server dashboard would be a Sunday-afternoon project they
  defer; clicking the button takes 90 seconds.
- **Schema-only changes are cheap.** Pre-alpha lets us add columns
  with a wipe-and-recreate migration. No real users to migrate.
- **Identical API on both backends.** The UI bundle ships once. We
  can iterate on the static files without touching either server.
- **Push beats pull on the architecture.** It keeps the dashboard
  worker decoupled from whatever cache backend the user picked,
  which was the whole point of using Turbo's spec verbatim.

## Open questions

- **Authentication for ingestion: separate token vs. reuse.** Leaning
  separate (`VZN_DASHBOARD_TOKEN`) for surface decoupling; could
  reuse `VZN_REMOTE_CACHE_TOKEN` for fewer secrets. Decision: separate;
  a user can set both to the same value if they want.
- **D1 row limits.** D1 has a 25MB per-query response cap. The Runs
  list could exceed that for very long histories. Mitigation: server
  pagination is mandatory; `limit` defaults to 50 and caps at 1000.
- **Static-asset binding vs. separate Pages project.** Cloudflare's
  newer Workers static-assets binding (in `wrangler.toml`'s `[assets]`)
  is the simpler path. Older "Worker + Pages" two-project model adds
  deploy complexity. We go single-Worker.
- **UI live-reload during development.** Bun.serve has no hot reload;
  contributors will Cmd-R. Fine for now — the entire UI is under 1000
  lines.
- **Bun on Windows + browser-open.** `start` works but Bun on Windows
  is less battle-tested. The local server should still work; the
  capture columns (CPU/RSS) write NULLs and the UI handles those.

## References

- d3-flame-graph: <https://github.com/spiermar/d3-flame-graph>
- Alpine.js: <https://alpinejs.dev>
- Cloudflare Workers + D1: <https://developers.cloudflare.com/d1/>
- Deploy to Cloudflare button:
  <https://developers.cloudflare.com/workers/platform/deploy-buttons/>
- ULID spec: <https://github.com/ulid/spec>
- NX Cloud (the inspiration we're disintermediating):
  <https://nx.app>
