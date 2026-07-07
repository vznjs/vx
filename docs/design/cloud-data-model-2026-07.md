# vx-cloud data-first entity model — design

> **Status:** proposal (2026-07-07)
> **Owner ask (verbatim):** "Redesign vx cloud around workspaces, projects,
> tasks, runs, cache but from DATA perspective. Like when connecting we can
> access the LOCK so load all projects dig into them etc. In runs I can
> navigate dig connect, even when I schedule from UI. And I want to trigger
> MULTIPLE. We should have ONE view for runs. Where I can spawn more."
> **Builds on (not re-litigated):** the push-fed `IngestStore` — the serve
> NEVER reads a workspace `cache.db` (2026-06-28); the colocated-workspace
> live-feature precedent (`/v1/graph` = a no-exec `planRun`, degrades cleanly
> on a remote serve); the capabilities-signal degradation pattern
> (`ui/src/api.ts`); one-run-at-a-time in the cockpit (2026-06-27 — the
> output-cleaning race); TaskLogs / cache-key diff / compare / run-detail
> RunViz, all shipped and reused as-is; the serve auth model
> (bearer + trust tiers, `security-review-2026-07.md`).

## 1. What we're solving

The dashboard grew feature-by-feature into eight nav entries where the same
underlying entities appear under different names with no links between them:

- **Two run surfaces.** `/run` (the live WS cockpit) and `/runs` (the
  historical invocations table) are disjoint. A run triggered in the cockpit
  never appears as a navigable row until you leave and find it in `/runs`;
  a second trigger is forbidden while one is in flight.
- **Projects/Tasks pages only know what has RUN.** They are SQL rollups over
  ingested run history. A freshly cloned workspace with 50 projects shows an
  empty Projects page. The workspace's own catalog — which vx already
  freezes into `vx-lock.json` and can resolve live (`vx show`) — is invisible
  to the dashboard.
- **No drill-down contract.** From a run's task row you cannot reach that
  task's config, its project, its cache entry, or its history; from a cache
  entry you cannot reach the run that produced it.

The redesign makes five entities first-class — **Workspace → Projects →
Tasks**, plus **Runs** and **Cache** — where every page is a view over data
with links in both directions, the workspace catalog is served from the lock
(or live eval), and Runs is ONE surface where you spawn, queue, watch, and
dig into runs.

## 2. Access pattern

What actually gets requested, by whom, how often:

| Access                         | Frequency                                             | Payload         | Source today                           |
| ------------------------------ | ----------------------------------------------------- | --------------- | -------------------------------------- |
| "What projects/tasks exist?"   | every dashboard session; feeds pickers + entity pages | ~1-100 KB JSON  | **missing** — only run-history rollups |
| Resolved config of one task    | on drill-down click                                   | <2 KB           | **missing** (CLI-only via `vx show`)   |
| Trigger a run, watch it        | many/day (dev), the daily loop                        | WS event stream | `/run` cockpit, 1 at a time            |
| Trigger N runs back-to-back    | owner ask; "queue lint, then test, then build"        | N submissions   | forbidden                              |
| Run history + drill-in         | many/day                                              | SQL reads       | `/v1/runs`, `/v1/invocations` — good   |
| Cache entry ↔ task ↔ run joins | on investigation                                      | SQL reads       | queries exist, links don't             |

The catalog is read-heavy, small, and changes only when config files change —
perfect for the lock-first + memoized-live-eval design below. Run triggering
is write-path and must stay serialized (correctness) but queueable (UX).

## 2.5 Positioning — "a CI, but better" (owner scope)

Owner (verbatim): "one stop shop for running things … see all data,
analytics, logs, artifacts … compete with GitHub Actions, Jenkins, Nx
Cloud." The reconciliation with the standing ci-platform-2026-07 wedge
("vx is the layer INSIDE any CI"): **vx-cloud competes on the RUN
EXPERIENCE and operations** — one place to trigger, queue, watch, debug,
and analyze everything — while git-event triggers and hosted compute stay
out of scope (agents supply compute; CI/webhooks supply triggers). The
competitive bar per surface:

- **Run detail beats a GHA job page**: live logs + DAG + flame + cache
  provenance + verify/hermeticity verdicts + artifacts, in ONE view.
- **The Runs surface beats Jenkins' build history**: live + queued +
  historical interleaved, spawn/re-run in place, compare in a click.
- **Insights beats Nx Cloud's analytics**: trends, flaky tasks, duration
  tails, cache savings, hit-rate split — each drilling into the entity.

This design is a UNIFICATION, not a rebuild: per-task logs, the GHA job
summary, flaky detection (`getFlakiestTasks` + `attempts`), LPT dispatch,
distributed agents + the multi-run scheduler, `--verify` verdicts, the
cache-key diff, and run compare all EXIST — the entity IA is where each
one finally becomes discoverable from every angle.

Scheduled/webhook-triggered runs would make vx-cloud a genuine CI
platform (Jenkins' core is triggers). That reverses a standing non-goal,
so it ships only as the explicitly-flagged Phase 4 pending an owner
decision — everything else here works without it.

## 3. Entity model + IA

### 3.1 The five entities and their data sources

| Entity      | Identity                 | Catalog source (colocated serve)                      | Analytics source (any serve)                                   |
| ----------- | ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------- |
| Workspace   | `workspaceId` (existing) | `vx-lock.json` / live eval — root, project count      | `/v1/workspaces`, trends, heatmap                              |
| Project     | `name`                   | lock entry / `loadProjectConfig` — dir, tasks, config | `ProjectRollup` (`/v1/projects`)                               |
| Task        | `project#task`           | resolved `TaskConfig` (the `vx show` payload)         | `TaskHistoryRow`, `/v1/tasks/:id`, explain                     |
| Run         | `runId`                  | — (runs are events, not config)                       | `/v1/invocations`, `/v1/runs/:id`, why/diff, compare, TaskLogs |
| Cache entry | `hash`                   | —                                                     | `/v1/cache/entries`, hit-split, prunable                       |

A page never invents a new data shape: it JOINS the catalog column (when the
serve is colocated) with the analytics column (always available). On an
ingest-only remote serve the catalog column is simply absent and every page
degrades to exactly today's behavior — the established capabilities pattern.

Two CROSS-CUTTING surfaces complete the one-stop shop (Phase 2):

- **Artifacts** — the `/v8` artifact store already exists server-side, and
  TaskLogs already renders a bearer-fetched artifact download link.
  Generalize: an Artifacts card on the Run entity page (every task's
  artifact: hash, size, download) and on the Cache entry page. No new
  storage — a thin `GET /v1/runs/:id/artifacts` projection over the runs
  rows joined with `/v8` existence.
- **Insights** — the `metrics.ts` analytics (trends, flaky tasks +
  `attempts`, duration tails, cache savings, hit-rate split) unified into
  the entity pages per §3.2 (Workspace absorbs Trends, Tasks absorbs
  Bottlenecks + flaky) rather than a separate silo — every insight row
  links to its entity.

### 3.2 Old IA → new IA (what merges, what dies)

| Today                                                                                              | Fate                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/run` — live cockpit (RunConsole)                                                                 | **DIES as a route.** Its machinery (WS session, live statuses, graph/flame toggle, critical path, log panel) is extracted into a `RunSession` component embedded in the unified `/runs`. Route redirects.       |
| `/runs` — invocations table + separate "Compare to previous" table                                 | **BECOMES the one Runs surface**: spawn bar + live/queued section + history table. The second compare table merges into the history table as a per-row action (icon link → `/compare/:id`).                     |
| `/runs/:id` — run detail (RunViz graph/flame, invocation facts, TaskLogs, why-did-this-rerun diff) | **Stays.** This is already the Run entity page; it gains outbound links (task → `/tasks/:id`, project → `/projects/:name`) and a `?task=` deep-link that seeds the selected-task card. Nothing here is rebuilt. |
| `/compare/:id`                                                                                     | Stays, reached from run rows + run detail.                                                                                                                                                                      |
| `/overview`                                                                                        | **Becomes the Workspace entity page** (nav label "Workspace", route kept for bookmarks). Adds a catalog summary card (projects/tasks from the lock, `source: lock/live` badge) above the existing metrics.      |
| `/projects`, `/projects/:name`                                                                     | Stay; become **catalog-backed** (all projects, including never-run) joined with rollups. Detail page gains the resolved per-task config blocks.                                                                 |
| `/tasks`, `/tasks/:id`                                                                             | Stay; task detail gains a "Config" card (the `vx show` payload: command, dependsOn, inputs, outputs, timeout, persistent) beside the existing history/entry/explain cards.                                      |
| `/cache`                                                                                           | Stays; gains `/cache/:hash` entity page (entry facts + producing task/run links).                                                                                                                               |
| `/trends`                                                                                          | **Merges into the Workspace page** (its cards move there). Nav entry dies; route redirects.                                                                                                                     |
| `/bottlenecks`                                                                                     | **Merges into the Tasks page** (a ranked card). Nav entry dies; route redirects.                                                                                                                                |

New nav (5 entries, entity-ordered): **Runs · Workspace · Projects · Tasks ·
Cache**. Command palette keeps every old destination searchable.

### 3.3 Drill-down contract (both directions)

```
Workspace ── projects ──> Project ── tasks ──> Task ── runs ──────> Run
    ^            ^            ^                  ^  ^                │
    │            │            └── back-link ─────┘  └── history ─────┤
    │            └────────────── back-link ─────────────────────────┤
    └─────────────────────────── switcher (existing) ───────────────┘
Task ── latest entry ──> Cache entry ── produced by ──> Run
Run ── task row ──> Task; Run ── why-diff (in-page); Run ── compare ──> Run
```

## 4. The workspace catalog — "access the lock"

### 4.1 Placement and the standing independence rule

This is a **colocated-workspace live feature**, exactly like `/v1/graph`:
the serve reads the workspace's **committed config surface** (`vx-lock.json`
and `vx.config.*` files) — never core's `cache.db`, never the `.vx/` state
dir. The serve stays independent and deployable anywhere; a remote
ingest-only serve 404s these endpoints and the dashboard hides the catalog
(capabilities gate, §4.5).

### 4.2 Resolution ladder

1. **Lock-first (instant, zero eval):** `readLockfile(root)` — the frozen
   resolved configs, exactly what a `--frozen` run would see. This is the
   owner's "access the LOCK" path.
2. **Live fallback (no lock):** `loadWorkspace(root)` → `listProjects` →
   `loadProjectConfig(configPath)` per project — the same loader chain
   `vx show` uses (`src/cli/show.ts renderList`). Costs ~200 ms at 1000
   projects on first hit; memoized after (below).
3. **No workspace:** 404 `{ error: 'no colocated workspace' }`.

**Memoization:** one in-serve `WorkspaceCatalog` instance memoizes per
`(configPath, mtimeMs, size)` — both the live-eval result and the
lock-staleness hash. Warm catalog requests are stat-only. No TTL games; a
touched config file invalidates its own entry.

**Staleness (lock mode):** for each lock entry, compare `entry.configHash`
against `xxh3hex(current file bytes)` — the same digest `vx lock` wrote.
Projects whose bytes drifted are listed in `staleProjects` and flagged
per-project; the response never silently mixes lock + live (one `source`
per response, staleness is a label). The UI renders a "lock is stale for N
projects — run `vx lock`" hint, mirroring the CLI's own contract
(runs trust, `--check` audits).

### 4.3 Endpoints (all behind the existing bearer gate — `/v1/*` is already gated)

```
GET /v1/workspace/projects
200 {
  source: 'lock' | 'live',
  root: '/abs/workspace/root',            // parity with /version (token-gated)
  lockedAt?: 1751850000000,               // lock file mtime (lock mode)
  staleProjects?: ['app'],                // lock mode: configHash drift
  projects: [
    { name: '@acme/app', dir: 'packages/app', configPath: 'packages/app/vx.config.ts',
      taskCount: 4, tasks: ['build', 'test', 'lint', 'dev'] }
  ]
}
404 { error: 'no colocated workspace' }

GET /v1/workspace/projects/:name           // :name URI-encoded
200 {
  source: 'lock' | 'live',
  name: '@acme/app', dir: 'packages/app', configPath: '…',
  stale?: true,                            // lock mode, this project drifted
  config: ProjectConfig                    // resolved, JSON-normalized — the
}                                          // `vx show <project> --format json` payload
404 { error: 'unknown project: x' }        // (also: no colocated workspace)

GET /v1/workspace/tasks                    // flat index for pickers + joins
200 {
  source: 'lock' | 'live',
  tasks: [
    { id: '@acme/app#build', project: '@acme/app', task: 'build',
      description?: '…', group: false, cacheable: true, persistent: false,
      dependsOn: ['^build'] }
  ]
}
404 { error: 'no colocated workspace' }
```

Derived booleans are computed serve-side from the resolved config
(`group` = `exec === undefined`, `cacheable` = `cache !== undefined`,
`persistent` = `exec?.persistent !== undefined`) so views never re-derive
schema semantics.

### 4.4 The one strictly-necessary core change: façade exports

`src/index.ts` today exports `findWorkspaceRoot` but NOT the lockfile
reader or the workspace/config loaders, and the name `listProjects` is
already taken by the metrics query. Phase 1 widens the façade —
**export-only, zero behavior, zero hot-path cost**:

```ts
// src/index.ts additions
export { readLockfile, LOCKFILE_NAME } from './workspace/index.js'
export type { Lockfile, LockfileEntry } from './workspace/index.js'
export {
  loadWorkspace,
  loadProjectConfig,
  listProjects as listProjectMetas, // metrics' listProjects keeps the bare name
} from './workspace/index.js'
export type { ProjectMeta } from './workspace/index.js'
```

`tests/package-boundaries.test.ts` snapshot updates deliberately. The
alternative — the cloud package re-parsing `vx-lock.json` itself — was
rejected: it duplicates a versioned on-disk format's validation
(`LOCKFILE_VERSION` gate, shape checks) in a second package that would
drift. The lock format already carries its version sentinel; there is
exactly one reader.

### 4.5 Degradation + capabilities

`ui/src/api.ts Capabilities` gains `catalog: boolean`, probed by one
`GET /v1/workspace/projects` (200 → true; 404/error → false) alongside the
existing probes. Catalog-backed cards carry `visible` gates on it — the
identical pattern `capsCacheMissing` uses today. An OLD serve binary
(predating these routes) 404s the probe too, so a new SPA against an old
serve degrades correctly for free.

### 4.6 Trust note (accepted residual)

Resolved configs can embed env-derived values folded at eval/lock time
(the lock file shares this property; it's committed to the repo). The
endpoints sit behind the same bearer that already guards `/version`'s
workspace path and the run-execution WS — no new tier. Documented, not
mitigated further.

## 5. ONE runs view with multi-trigger

### 5.1 Why serialized (honest version)

Two concurrent runs with different hashes over overlapping scopes race on
output cleaning: `cleanOutputs` wipes declared outputs before exec/restore,
so run B can delete files run A just produced mid-restore (the 2026-06-27
decision that made the cockpit forbid a second run). The real fix —
a global scheduler with output RW-locks — is the deferred roadmap of
`docs/design/execution-service-2026-06.md` §6 (items 1-2) and is NOT built
here. What we build instead is the safe, honest middle: a **serve-side FIFO
run queue, one run executing at a time**, so "trigger MULTIPLE" means
_queue_ multiple and watch them flow `queued → running → done` in one view.
The user gets the owner's ask; correctness never depends on scope analysis.

Today's UI-side forbid was a paper guard anyway: two CLI `vx run`s delegated
to the same serve already execute concurrently and can race. Routing **all**
serve-executed runs through the queue closes that pre-existing exposure too.

### 5.2 Serve-side `RunQueue`

New `packages/cloud/src/run-queue.ts` — in-memory (like `AgentRegistry`;
a serve restart drops queued jobs loudly, acceptable pre-alpha):

```ts
interface QueuedJob {
  jobId: string // crypto.randomUUID()
  request: RunRequest
  state: 'queued' | 'running' | 'done'
  submittedAt: number
  startedAt?: number
  runId?: string // known once the run's summary lands
  ok?: boolean
}

class RunQueue {
  constructor(opts: {
    execute: (job: QueuedJob) => Promise<boolean> // wraps executeRequest
    maxQueued?: number // default 32; overflow → refuse
    onUpdate?: (jobs: readonly JobView[]) => void // positions changed
  })
  submit(request: RunRequest): { jobId: string; position: number } | { error: string }
  cancel(jobId: string): boolean // queued jobs only; running is not killable (§8)
  jobs(): JobView[] // queued + running (done jobs drop out)
}
```

Execution is a promise chain: at most one `execute` in flight; completion
pulls the next job and fires `onUpdate`. Position 0 with an idle queue
starts synchronously — the solo case is byte-equivalent to today's
immediate execution.

`serve.ts` changes: `executeRequest` becomes the queue's `execute` (same
silent logger, same `inflight` map — now mostly idle under serialization
but kept: it costs nothing and phase 3 concurrency reuses it — same
`selfIngestSink` + `serveLogSink`, plus one **per-job sink**
`{ onRunSummary: s => job.runId = s.run.runId }` so the queue learns the
runId without any core change). The plain `{ t: 'run' }` WS message (CLI
delegation) **also enqueues**; when it doesn't start immediately the serve
streams one `{ t:'event', event:{ kind:'run:status', line:'vx: queued behind N run(s) on this serve' } }`
so a delegated CLI user sees why nothing is happening (`run:status` is an
existing WireEvent the wire renderer already prints — verify ordering
before `run:start` renders sanely; test listed in §7). `dist:submit`
(distributed submissions) does NOT ride the queue — agents execute in their
own checkouts; there is no shared output tree on the serve to race on.

Behavior change, named: concurrent CLI-delegated runs were previously
concurrent (inflight-dedup joining identical tasks); they now serialize. A
same-input second run waits, then cache-hits everything — similar wall
time, strictly safer for the different-input case that used to race.

### 5.3 Wire — minimal change, reuses the run WS + RunConsole machinery

New **cloud-owned** message families on the existing run WebSocket
(precedent: `dist:submit` lives in `protocol-dist.ts`, not core's
`ClientMessage`; core's `protocol.ts` is untouched). Types in
`packages/cloud/src/protocol-queue.ts`, `QUEUE_PROTOCOL_VERSION = 1`:

```
client → serve
  { t: 'queue:submit', v: 1, request: RunRequest }
  { t: 'queue:cancel', v: 1, jobId }

serve → client (on the submitting socket)
  { t: 'queue:accepted', jobId, position }        // position 0 = starting now
  { t: 'queue:update',   jobId, position }        // earlier jobs finished
  { t: 'queue:start',    jobId }
  … then the standard { t:'event', event } stream + { t:'result' } …
  { t: 'queue:done',     jobId, runId?, ok }      // runId links to /runs/:id
  { t: 'queue:refused',  message }                // full queue / bad request
```

The submitting socket is the stream — no run-id tagging of the shared
broadcast, no new SSE plumbing, and the entire existing `RunConsole` event
handler (`run:start`/`task:*`/`result`) works unchanged per socket. The UI
holds one WS per active job (N queued runs = N cheap idle sockets; browsers
handle dozens). Closing the socket of a QUEUED job cancels it; closing a
RUNNING job's socket stops watching (the run completes server-side —
today's Stop semantics, unchanged).

Rejected alternative: `POST /v1/runs` + per-run SSE. It needs run-id-tagged
event streams, a second transport for the same events, and a rewrite of the
cockpit's consumption path — more wire for no added capability in phase 1.

One read endpoint for the unified view's live section (poll while
non-empty, 2 s):

```
GET /v1/runs/queue
200 { jobs: [ { jobId, tasks: ['lint'], state: 'queued'|'running',
                position, submittedAt, startedAt? } ] }
```

This also surfaces CLI-delegated runs as rows (state only — their event
stream belongs to the submitting CLI; attaching the dashboard to a foreign
live run needs tagged broadcast, deferred to phase 2's option list).

### 5.4 The unified Runs view (`#/runs`)

An interactive Solid route (like RunConsole was — a live WS console can't
be a pure-JSON view; the jsonPage `runs.json` dies and its history table is
rebuilt with the same `DataTable` catalog component used directly in JSX,
which the two-way catalog explicitly supports):

```
┌─ Runs ────────────────────────────────────────────────────────┐
│ [ task input (datalist ← /v1/workspace/tasks, fallback:       │
│   history-derived names) ]  [Run]        queue: 2 waiting     │
├─ Active ──────────────────────────────────────────────────────┤
│ ▸ test        running   ██████░░ 12/17      [expand ▾]        │
│     └─ expanded: RunSession (live graph/flame toggle,         │
│        critical path, per-task logs — the extracted cockpit)  │
│ ▸ build       queued    position 1          [cancel]          │
│ ▸ lint (cli)  queued    position 2                            │
├─ History (newest first) ──────────────────────────────────────┤
│ run 019e32…  2m ago  main  ✓ 17 tasks  12 hits   [⇄ compare] │  → /runs/:id
│ …                                                             │
└───────────────────────────────────────────────────────────────┘
```

- **Spawn bar always enabled** (when the serve has a workspace): each press
  `queue:submit`s a new job. Multi-trigger = the queue.
- **Active rows** are UI-owned jobs (own WS, expandable live `RunSession`)
  plus foreign jobs from `/v1/runs/queue` (state-only rows).
- **On `queue:done`** the active row collapses and the history list
  refetches; the row's link target is `/runs/:runId` — the SAME run-detail
  page (recorded graph/flame via RunViz, TaskLogs, why-diff) that
  historical rows use. Live and historical drill-down share the visual
  components; the live feed is socket-driven, the historical one SQL-driven.
- `/run` redirects to `/runs`; the capability-aware Home redirect target
  becomes `/runs` unconditionally.

`RunSession.tsx` is extracted from `RunConsole.tsx` (the per-run state
stores, event handler, layout). It keeps consuming `RunGraph` / `Flamegraph`
through their existing props — **those two files are being modified in
parallel and this design specifies nothing about their internals**.

## 6. Navigation / linking contract

| Route                          | Page                                                    | Inbound links                                   | Outbound links                                                                                            |
| ------------------------------ | ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/runs`                        | unified Runs (spawn + live + history)                   | nav, Home                                       | row → `/runs/:id`; compare → `/compare/:id`                                                               |
| `/runs/:id`                    | Run entity (exists)                                     | runs rows, task history, `queue:done`           | task row → `/tasks/:proj%23task`; project → `/projects/:name`; `/compare/:id`; TaskLogs artifact (exists) |
| `/runs/:id?task=<proj%23task>` | same, selected-task card pre-opened                     | cache entry "produced by", task history rows    | (as above)                                                                                                |
| `/compare/:id`                 | run diff (exists)                                       | run rows, run detail                            | both runs' details                                                                                        |
| `/overview`                    | Workspace entity (relabeled)                            | nav                                             | `/projects`, `/runs`, trend cards                                                                         |
| `/projects`                    | Projects (catalog ∪ rollups)                            | nav, workspace                                  | row → `/projects/:name`                                                                                   |
| `/projects/:name`              | Project entity                                          | projects rows, run/task back-links              | task rows → `/tasks/:id`; runs filtered link                                                              |
| `/tasks`                       | Tasks (catalog ∪ history, + bottlenecks card)           | nav, project                                    | row → `/tasks/:id`                                                                                        |
| `/tasks/:id`                   | Task entity (config + history + explain + latest entry) | run task rows, project task rows, cache entries | project, `/runs/:runId?task=…` per history row, `/cache/:hash`                                            |
| `/cache`                       | Cache entries + stats                                   | nav, task                                       | row → `/cache/:hash`                                                                                      |
| `/cache/:hash`                 | Cache-entry entity (phase 2)                            | cache rows, task detail                         | `/tasks/:id`, producing `/runs/:runId`                                                                    |

The `?task=` deep link is a small `jr/page.tsx` addition: expose decoded
query params in loader state and seed `/selectedTask` from them (the
run-detail card already binds `/selectedTask` via `useStateBinding`).
Task ids in URLs stay URI-encoded `project#task` — the existing `/tasks/:id`
convention.

## 7. Phasing — each shippable

### Phase 1 — catalog endpoints + unified Runs with queue (the owner's core asks)

Core (export-only):

- `src/index.ts` — the §4.4 exports.
- `tests/package-boundaries.test.ts` — snapshot widening.

Cloud serve:

- `packages/cloud/src/workspace-catalog.ts` — NEW: lock/live resolution
  ladder, mtime-keyed memo, staleness hashing, derived task index.
- `packages/cloud/src/run-queue.ts` — NEW: FIFO executor per §5.2.
- `packages/cloud/src/protocol-queue.ts` — NEW: `queue:*` message types,
  `QUEUE_PROTOCOL_VERSION`.
- `packages/cloud/src/cli/serve.ts` — three `/v1/workspace/*` routes,
  `GET /v1/runs/queue`, WS `queue:submit`/`queue:cancel` handling, route
  the plain `run` message through the queue, per-job runId sink.

Cloud UI:

- `packages/cloud/ui/src/api.ts` — catalog fetchers, `Capabilities.catalog`
  probe, `queueRun()` (submit + queue message handling atop the existing
  socket helper), queue poller.
- `packages/cloud/ui/src/components/RunSession.tsx` — NEW: extracted from
  `RunConsole.tsx` (state stores + event handler + live layout; consumes
  RunGraph/Flamegraph via existing props — those files untouched).
- `packages/cloud/ui/src/components/RunsView.tsx` — NEW: spawn bar + active
  jobs + history table (DataTable used directly in JSX).
- `packages/cloud/ui/src/main.tsx` — `/runs` → RunsView, `/run` redirect,
  Home → `/runs`.
- `packages/cloud/ui/src/components/Shell.tsx` — nav update (Runs first;
  Run entry removed).
- `packages/cloud/ui/src/views/runs.json` — DELETED (superseded).
- rebuild `ui/dist` (not committed — build artifact).

Docs: `docs/cli.md` serve section (+3 endpoints, queue semantics),
`apps/docs` guides/dashboard.md (unified Runs, catalog).

Tests (phase 1):

1. serve-catalog: lock-backed list/detail/tasks payload shapes (fixture
   workspace + `vx lock`-written lockfile).
2. serve-catalog: live fallback when no lock (payload `source: 'live'`,
   equals the lock-backed shape for the same fixture).
3. serve-catalog: staleness — edit one config file after lock →
   `staleProjects` names it; per-project `stale: true`.
4. serve-catalog: memoization — second request re-reads nothing (spy on
   loader / fs read count).
5. serve-catalog: ingest-only serve (no workspace) → 404 all three routes.
6. serve-catalog: 401 without bearer on a token-gated serve.
7. serve-catalog: unknown project → 404 with name.
8. run-queue unit: FIFO order; one-at-a-time (second `execute` not entered
   until first resolves); position updates fire; maxQueued refusal.
9. run-queue unit: cancel queued removes + renumbers; cancel running → false.
10. serve e2e: two `queue:submit`s → first streams events, second holds at
    `queue:accepted position 1` then starts after first's `result`;
    `queue:done` carries the runId that `/v1/runs/:id` then resolves.
11. serve e2e: plain `{t:'run'}` (CLI delegation) enqueued behind a UI job —
    the run:status queue line streams first and renders through
    `createWireRenderer` without breaking output (the §5.2 verify item).
12. serve e2e: socket close on a queued job cancels it; `/v1/runs/queue`
    reflects queued + running states.
13. boundary: package-boundaries snapshot pins the new façade exports.

### Phase 2 — entity-page IA migration

- `data.ts` sources: `catalogProjects`, `catalogProject`, `catalogTasks`;
  join helpers in `functions.ts` (catalog ∪ rollup merge keyed by
  name/taskId).
- `views/projects.json`, `projectDetail.json`, `tasks.json`,
  `taskDetail.json` — catalog cards + `visible` gates on the catalog
  capability; drill-down `rowHref`s per §6.
- `views/overview.json` → Workspace page (catalog summary card + absorb
  `trends.json` cards); `tasks.json` absorbs `bottlenecks.json`; both old
  routes redirect; nav shrinks to the five entities.
- `views/cacheEntry.json` (NEW, `/cache/:hash`) + a `cacheEntry` source
  (filter of `listCacheEntries` by hash + producing-run lookup via
  `listRuns({ … })` hash match).
- `jr/page.tsx` — query params into loader state (`?task=` seeding).
- Tests: source join units; a route-redirect pin; serve test for any new
  query param; browser-driven e2e over the built SPA (the established CDP
  verification, not bun-test).

### Phase 3 (optional) — non-overlapping concurrent runs

Allow a queued job to start alongside the running one when their planned
node sets are provably disjoint (a `planRun` per submission — cheap, no
exec — intersect task-id sets AND declared output roots; any
`outputs.workspaceFiles` anywhere → never parallel). This is a scheduling
optimization on top of the same queue, NOT the general fix; true
overlapping concurrency stays with the execution-service roadmap's global
scheduler + output RW-locks. Only build when queue wait times demonstrably
hurt.

### Phase 4 (FLAGGED — owner decision required) — triggers

Scheduled runs (cron on the serve) and webhook-triggered runs (a
`POST /v1/hooks/:id` a forge webhook can hit) would make vx-cloud a
self-sufficient CI for the run half. This REVERSES the standing
"triggers belong to the CI provider" non-goal (ci-platform-2026-07) —
Jenkins' core is exactly this. Everything in Phases 1–3 works without
it; do not build any of it until the owner explicitly reverses the
non-goal. Sketch only: a `schedules.json` beside `environments.json`,
jobs enqueue through the SAME RunQueue, runs land in the same Runs view.

## 8. What's out of scope

- **RunGraph.tsx / Flamegraph.tsx internals** — being modified in parallel;
  this design only consumes their existing props.
- **Killing a RUNNING run from the UI.** Core `run()` has no abort handle
  (`handleSignals: false` delegated runs run to completion); adding
  cancellation is real core plumbing. "Stop" keeps today's semantics: stop
  watching.
- **Attaching the dashboard to a foreign (CLI-submitted) live run's event
  stream.** Needs run-tagged broadcast envelopes; queued-state rows only in
  phase 1.
- **Distributed (`dist:submit`) runs in the queue** — different execution
  substrate, no serve-local output tree; fairness there is the
  universal-agents workstream.
- **Persisting the queue across serve restarts.**
- **Editing configs from the dashboard.** The catalog is read-only.
- **Any `cache.db` access from the serve** — unchanged standing decision.
- **New telemetry fields / schema bumps** — none: no `CACHE_VERSION`,
  no `SCHEMA_VERSION`, no `TELEMETRY_SCHEMA_VERSION`, no core wire change
  (`protocol.ts` untouched; queue messages are cloud-owned like `dist:*`).

## 9. Open questions

1. **Queue + persistent tasks:** a queued run requesting a persistent task
   executes server-side where persistent children are SIGTERMed at graph
   end (existing delegated-run behavior), so it can't wedge the queue — but
   the UX is a dev server that dies instantly. Refuse `queue:submit` for
   graphs whose requested nodes are persistent, or allow with a warning?
   (Lean: refuse with a clear message; revisit with real demand.)
2. **`/v1/workspace/*` on the unix socket:** works for free (same fetch
   handler); nothing to decide, just test coverage.
3. **Catalog for a MULTI-workspace serve:** the catalog is inherently
   single-workspace (the colocated one). The `?ws=` param is ignored by
   these routes; the UI shows the catalog only when the selected workspace
   matches the colocated one's id — needs `/v1/workspace/projects` to also
   return the colocated `workspaceId` for the match. Cheap; decide during
   phase 1 implementation.

## 10. Why this is the right move

- **It's the owner's literal ask,** built from data that already exists:
  the lock (`readLockfile`), the loader (`vx show`'s chain), the run wire
  (RunConsole's WS), and the analytics queries — composed, not rebuilt.
- **Near-zero core surface:** export-only façade widening; core hot paths,
  wire protocol, schemas, and cache versions are byte-untouched; plain
  `vx run` users pay nothing.
- **The queue converts a UI prohibition into a capability** while CLOSING a
  real pre-existing race (concurrent CLI delegations), without pretending
  to solve concurrent scheduling — that stays honestly deferred to the
  execution-service roadmap.
- **Degradation is uniform:** every catalog surface rides the established
  capabilities pattern, so the remote ingest-only serve keeps working with
  the features simply absent — the plugin-fed architecture stands.
- **Existing crown jewels slot in, not out:** run-detail RunViz, TaskLogs,
  the cache-key diff, and compare become the drill-down TARGETS of the new
  links — no rewrite of the parts that already win comparisons.
