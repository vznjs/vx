# vx-cloud data-first entity model — design

> **Status:** proposal (2026-07-07)
> **Owner ask (verbatim):** "Redesign vx cloud around workspaces, projects,
> tasks, runs, cache but from DATA perspective. Like when connecting we can
> access the LOCK so load all projects dig into them etc. In runs I can
> navigate dig connect, even when I schedule from UI. And I want to trigger
> MULTIPLE. We should have ONE view for runs. Where I can spawn more."
> **Owner scope update (verbatim):** "Make sure the new VX Cloud is like a CI
> but better. It is one stop shop for running things. It should be possible
> to do there EVERYTHING — see all data, analytics, logs, artifacts. It
> should compete with GitHub Actions, Jenkins, Nx Cloud."
> **Builds on (not re-litigated):** the push-fed `IngestStore` — the serve
> NEVER reads a workspace `cache.db` (2026-06-28); the colocated-workspace
> live-feature precedent (`/v1/graph` = a no-exec `planRun`, degrades cleanly
> on a remote serve); the capabilities-signal degradation pattern
> (`ui/src/api.ts`); one-run-at-a-time in the cockpit (2026-06-27 — the
> output-cleaning race); TaskLogs / cache-key diff / compare / run-detail
> RunViz / the `/v8` artifact store / flaky detection / verify verdicts —
> all shipped and REUSED, not rebuilt; the serve auth model (bearer + trust
> tiers, `security-review-2026-07.md`); the ci-platform wedge
> (`ci-platform-2026-07.md`) — reconciled in §2, not silently overridden.

## 1. What we're solving

vx-cloud becomes the **one-stop run-operations shop**: everything about
running — trigger, queue, watch, debug, analyze, download — in one place.
The pieces mostly EXIST; what's missing is the unification. Today:

- **Two run surfaces.** `/run` (the live WS cockpit) and `/runs` (the
  historical invocations table) are disjoint. A run triggered in the cockpit
  never appears as a navigable row until you leave and find it in `/runs`;
  a second trigger is forbidden while one is in flight.
- **Projects/Tasks pages only know what has RUN.** They are SQL rollups over
  ingested history. A fresh workspace with 50 projects shows an empty
  Projects page — while vx already freezes the full catalog into
  `vx-lock.json` and can resolve it live (`vx show`).
- **No drill-down contract.** From a run's task row you cannot reach that
  task's config, its project, its cache entry, its artifact, or its history.
- **Analytics are scattered** (Overview/Trends/Bottlenecks/flaky cards) and
  **artifacts are invisible** (the `/v8` store serves bytes but has no UI).

### The competitive bar, per surface

| Surface    | Competitor baseline                                                           | vx-cloud bar (this design)                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run detail | GHA job page: one log stream + annotations; Jenkins: console + artifacts tab  | ONE page: live DAG + flame, per-task logs, cache provenance (hit/miss, local/remote, why-did-this-rerun input diff), compare-to-previous, artifact downloads, (flagged) hermeticity verdicts                                                |
| Runs list  | Jenkins build history: rows + weather icons; GHA: workflow-run list, no spawn | Spawn bar + queue + LIVE runs + history interleaved in one view; branch/CI/tag filters (exist); per-row compare                                                                                                                             |
| Trigger    | GHA: push/PR/dispatch; Jenkins: everything                                    | Instant spawn + queue MULTIPLE from the UI or CLI against a warm serve — no YAML, no runner cold-start; git-event triggers stay out (§2)                                                                                                    |
| Insights   | Nx Cloud analytics (hosted-only)                                              | Flaky confirmed from within-run retries (a stronger signal than Nx's paid re-runs), cache savings, hit-rate split, bottleneck weekly-savings estimates, duration tails, parallelism — self-hosted, one Insights area with entity drill-down |
| Catalog    | none of them show resolved task config                                        | The lock/live catalog: every project + resolved per-task config, instant                                                                                                                                                                    |

## 2. Positioning — "compete with GHA/Jenkins/Nx Cloud" vs the standing wedge

The standing decision (`ci-platform-2026-07.md`) holds: vx is the portable
execution + cache + pool LAYER that runs INSIDE any CI provider, and
git-event **triggers**, **hosted runners**, **secrets management**, and a
**marketplace/DSL** are permanent non-goals. The owner's scope update
revises the **ambition**, not the boundary: vx-cloud competes on the RUN
EXPERIENCE and run OPERATIONS — one place to trigger, queue, watch, debug,
and analyze everything — while compute keeps coming from agents
(yours/CI-provisioned) and event triggers keep coming from your CI/webhooks
invoking `vx run`. Concretely: a team keeps GHA for "PR opened → run ci",
but every human interaction with runs — spawning, watching, digging,
downloading, analyzing — happens in vx-cloud, which is where GHA's job page
and Jenkins' UI lose.

**Explicitly flagged option (Phase 4, OWNER DECISION REQUIRED):**
scheduled/webhook-triggered runs on the serve (a cron table + a
`POST /v1/hooks/:id` endpoint feeding the run queue). This would REVERSE
the triggers non-goal. Named tradeoff: triggers are Jenkins' actual core —
adopting them pulls in checkout provisioning (which ref? clean tree?),
secrets handling for private repos, event-delivery reliability, and
retention policy — the exact territory the wedge deliberately avoided. Do
not build without the owner reversing the non-goal in the decision log.
Everything in Phases 1-3 is designed to make that addition PURELY ADDITIVE
(a trigger is just another `RunQueue.submit` caller) without presuming it.

## 3. Access pattern

What actually gets requested, by whom, how often:

| Access                           | Frequency                                   | Payload              | Source today                           |
| -------------------------------- | ------------------------------------------- | -------------------- | -------------------------------------- |
| "What projects/tasks exist?"     | every session; feeds pickers + entity pages | ~1-100 KB JSON       | **missing** — only run-history rollups |
| Resolved config of one task      | on drill-down click                         | <2 KB                | **missing** (CLI-only via `vx show`)   |
| Trigger a run, watch it          | many/day — the daily loop                   | WS event stream      | `/run` cockpit, 1 at a time            |
| Trigger N runs back-to-back      | owner ask                                   | N submissions        | forbidden                              |
| Run history + drill-in           | many/day                                    | SQL reads            | `/v1/runs`, `/v1/invocations` — good   |
| Task logs of a finished run      | on debug                                    | ≤128 KiB tail        | `/v1/runs/:id/logs/:task` — exists     |
| Artifact browse + download       | on debug/audit                              | list + tar.zst bytes | `/v8` GET exists; **no list, no UI**   |
| Analytics (flaky/savings/trends) | weekly review                               | SQL reads            | endpoints exist, views scattered       |
| Cache entry ↔ task ↔ run joins   | on investigation                            | SQL reads            | queries exist, links don't             |

The catalog is read-heavy, small, changes only when config files change —
lock-first + memoized live eval (§6). Run triggering is write-path: must
stay serialized (correctness), must become queueable (UX). Artifacts and
Insights are pure read surfaces over stores that already exist.

## 4. Entity model + IA

### 4.1 The entities and their data sources

Six entities (the owner's five + Artifacts) plus Insights, a cross-entity
analytics view:

| Entity            | Identity                 | Catalog source (colocated serve)                      | Analytics/store source (any serve)                                          |
| ----------------- | ------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Workspace         | `workspaceId` (existing) | `vx-lock.json` / live eval — root, project count      | `/v1/workspaces`, `/v1/agents` pool counts                                  |
| Project           | `name`                   | lock entry / `loadProjectConfig` — dir, tasks, config | `ProjectRollup` (`/v1/projects`)                                            |
| Task              | `project#task`           | resolved `TaskConfig` (the `vx show` payload)         | `TaskHistoryRow`, `/v1/tasks/:id`, explain, flaky flag                      |
| Run               | `runId`                  | — (runs are events, not config)                       | `/v1/invocations`, `/v1/runs/:id`, why/diff, compare, TaskLogs, queue state |
| Cache entry       | `hash`                   | —                                                     | `/v1/cache/entries`, hit-split, prunable                                    |
| Artifact          | `hash` (+ tier)          | —                                                     | the `/v8` store + new `/v1/artifacts` list (§8)                             |
| _Insights (view)_ | —                        | —                                                     | trends, heatmap, flaky, bottlenecks, savings, parallelism (all exist)       |

A page never invents a new data shape: it JOINS the catalog column (when
the serve is colocated) with the store/analytics column (always available).
On an ingest-only remote serve the catalog column is simply absent and
every page degrades to today's behavior — the established capabilities
pattern. Artifacts exist on ANY serve hosting `/v8` (including remote ones),
so that surface is NOT workspace-gated.

### 4.2 Old IA → new IA (what merges, what dies)

| Today                                                                                              | Fate                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/run` — live cockpit (RunConsole)                                                                 | **DIES as a route.** Its machinery (WS session, live statuses, graph/flame toggle, critical path, log panel) is extracted into a `RunSession` component embedded in the unified `/runs`. Route redirects.                                                                                              |
| `/runs` — invocations table + separate "Compare to previous" table                                 | **BECOMES the one Runs surface**: spawn bar + queued/live section + history. The second compare table merges into the history table as a per-row action (icon → `/compare/:id`).                                                                                                                       |
| `/runs/:id` — run detail (RunViz graph/flame, invocation facts, TaskLogs, why-did-this-rerun diff) | **Stays — this is already the Run entity page and the anti-GHA-job-page.** Gains outbound links (task → `/tasks/:id`, project → `/projects/:name`), per-task artifact download (generalizing TaskLogs' `artifactHash` link), and a `?task=` deep-link seeding the selected-task card. Nothing rebuilt. |
| `/compare/:id`                                                                                     | Stays, reached from run rows + run detail.                                                                                                                                                                                                                                                             |
| `/overview`                                                                                        | **Becomes the Workspace entity page** (nav "Workspace", route kept). Catalog summary card (projects/tasks, `lock/live` badge), identity, agent-pool card (§5); its analytics cards move to Insights.                                                                                                   |
| `/projects`, `/projects/:name`                                                                     | Stay; **catalog-backed** (all projects, incl. never-run) joined with rollups. Detail gains resolved per-task config blocks.                                                                                                                                                                            |
| `/tasks`, `/tasks/:id`                                                                             | Stay; task detail gains a "Config" card (the `vx show` payload) beside history/entry/explain, plus a flaky badge (`getFlakiestTasks` signal).                                                                                                                                                          |
| `/cache`                                                                                           | Stays; gains `/cache/:hash` entity page (entry facts + producing task/run + artifact link).                                                                                                                                                                                                            |
| `/artifacts`                                                                                       | **NEW** — the `/v8` store made visible (§8).                                                                                                                                                                                                                                                           |
| `/trends`                                                                                          | **Merges into `/insights`.** Nav entry dies; route redirects.                                                                                                                                                                                                                                          |
| `/bottlenecks`                                                                                     | **Merges into `/insights`.** Nav entry dies; route redirects.                                                                                                                                                                                                                                          |
| `/insights`                                                                                        | **NEW view area** unifying trends, heatmap, flaky (with the Retried column), bottlenecks, cache savings, hit-rate split, parallelism — every row/card links INTO its entity (task, project, run). No new endpoints.                                                                                    |

New nav (7 entries, entity-ordered): **Runs · Workspace · Projects · Tasks
· Cache · Artifacts · Insights**. Command palette keeps every old
destination searchable.

### 4.3 Drill-down contract (both directions)

```
Workspace ── projects ──> Project ── tasks ──> Task ── runs ──────> Run
    ^            ^            ^                  ^  ^                │
    │            │            └── back-link ─────┘  └── history ─────┤
    │            └────────────── back-link ─────────────────────────┤
    └─────────────────────────── switcher (existing) ───────────────┘
Task ── latest entry ──> Cache entry ── produced by ──> Run
Run ── task row ──> Task · why-diff (in-page) · compare ──> Run
Run ── task row ──> Artifact (download) <── Artifacts list ──> Task/Run
Insights ── any row/card ──> Task | Project | Run
```

## 5. Compose, don't rebuild — the inventory map

This redesign is the UNIFICATION of already-shipped capabilities into the
entity IA. Explicitly, what exists and where it lands (none of these are
rebuilt):

| Shipped capability                                                                                             | Where it lives today                                                                                                     | Entity page it slots into                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-task logs (`task-logs-2026-07`: bounded tails, cache-hit hash resolution, `logs.db`)                       | `/v1/runs/:id/logs/:task` + the run-detail TaskLogs card                                                                 | Run detail (unchanged); live logs in `RunSession`                                                                                                                                                   |
| Artifact store (`/v8/artifacts/:hash`, trust-scoped, immutable, tag+duration sidecars)                         | serve-side only, no UI                                                                                                   | **Artifacts** entity (§8) + per-task download links on Run detail (generalizes TaskLogs' bearer-fetched `artifactHash` link)                                                                        |
| Cache-key diff / why-did-this-rerun (`cacheKeyDiff`, `whyDidThisRerunQuery`)                                   | run-detail "Why did this re-run?" card                                                                                   | Run detail (unchanged); linked from Task history rows                                                                                                                                               |
| Run compare (`compareRuns`)                                                                                    | `/compare/:id` + a second table on `/runs`                                                                               | Runs history row action + Run detail link                                                                                                                                                           |
| Flaky detection (`getFlakiestTasks` + persisted `attempts`, within-run-retry CONFIRMED signal, Retried column) | `/v1/flakiness` + a dashboard card                                                                                       | **Insights** flaky panel + a flaky badge on Task detail                                                                                                                                             |
| Duration hints / LPT dispatch (`taskDurationHints`)                                                            | serve-internal dist scheduling                                                                                           | No UI work — inventory note; its data source (ingest history) is what Insights reads                                                                                                                |
| Distributed agents + multi-run fair scheduler (`/v1/agents` capacity read)                                     | serve-side; capacity endpoint exists                                                                                     | Workspace page "Pool" card (needs a small sessions-list read — Phase 2 optional, flagged in §12 open questions)                                                                                     |
| Verify / hermeticity verdicts (`VerifyVerdict` on telemetry, OTel spans, GHA summary)                          | streaming surfaces only — **NOT persisted in the ingest runs table** (the decision log's deferred SCHEMA-bump follow-up) | Run detail "Hermeticity" card — **FLAGGED, not designed in**: requires persisting `verify` on run rows = a SCHEMA bump this design forbids. Stays a named follow-up; until then the card is absent. |
| GHA job summary (`github-summary.ts`)                                                                          | CI-side formatter over the same `RunSummaryRecord`                                                                       | No UI work — proof the record already carries what Run detail needs                                                                                                                                 |
| Analytics queries (trends, heatmap, savings, hit-split, bottlenecks, parallelism, top-tasks, failures)         | endpoints exist; views scattered across Overview/Trends/Bottlenecks                                                      | **Insights** area (§9) — a views reorganization, zero new endpoints                                                                                                                                 |
| Run delegation WS + wire renderer                                                                              | `/run` cockpit + CLI delegation                                                                                          | The run queue (§7) wraps the SAME `executeRequest`                                                                                                                                                  |
| Lockfile + `vx show` loader chain                                                                              | core CLI only                                                                                                            | The workspace catalog (§6)                                                                                                                                                                          |

## 6. The workspace catalog — "access the lock"

### 6.1 Placement and the standing independence rule

This is a **colocated-workspace live feature**, exactly like `/v1/graph`:
the serve reads the workspace's **committed config surface** (`vx-lock.json`
and `vx.config.*` files) — never core's `cache.db`, never the `.vx/` state
dir. The serve stays independent and deployable anywhere; a remote
ingest-only serve 404s these endpoints and the dashboard hides the catalog
(capabilities gate, §6.5).

### 6.2 Resolution ladder

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
projects — run `vx lock`" hint, mirroring the CLI's own contract (runs
trust, `--check` audits).

### 6.3 Endpoints (behind the existing bearer gate — `/v1/*` is already gated)

```
GET /v1/workspace/projects
200 {
  source: 'lock' | 'live',
  root: '/abs/workspace/root',            // parity with /version (token-gated)
  workspaceId: 'a1b2…',                   // for the UI's colocated-ws match (§13.3)
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

### 6.4 The one strictly-necessary core change: façade exports

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

### 6.5 Degradation + capabilities

`ui/src/api.ts Capabilities` gains `catalog: boolean`, probed by one
`GET /v1/workspace/projects` (200 → true; 404/error → false) alongside the
existing probes. Catalog-backed cards carry `visible` gates on it — the
identical pattern `capsCacheMissing` uses today. An OLD serve binary
(predating these routes) 404s the probe too, so a new SPA against an old
serve degrades correctly for free. The Artifacts nav gates on the existing
`/v1/meta` `artifacts: true` advertisement.

### 6.6 Trust note (accepted residual)

Resolved configs can embed env-derived values folded at eval/lock time
(the lock file shares this property; it's committed to the repo). The
endpoints sit behind the same bearer that already guards `/version`'s
workspace path and the run-execution WS — no new tier. Documented, not
mitigated further.

## 7. ONE runs view with multi-trigger

### 7.1 Why serialized (honest version)

Two concurrent runs with different hashes over overlapping scopes race on
output cleaning: `cleanOutputs` wipes declared outputs before exec/restore,
so run B can delete files run A just produced mid-restore (the 2026-06-27
decision that made the cockpit forbid a second run). The real fix — a
global scheduler with output RW-locks — is the deferred roadmap of
`docs/design/execution-service-2026-06.md` §6 (items 1-2) and is NOT built
here. What we build instead is the safe, honest middle: a **serve-side FIFO
run queue, one run executing at a time**, so "trigger MULTIPLE" means
_queue_ multiple and watch them flow `queued → running → done` in one view.
The user gets the owner's ask; correctness never depends on scope analysis.

Today's UI-side forbid was a paper guard anyway: two CLI `vx run`s
delegated to the same serve already execute concurrently and can race.
Routing **all** serve-executed runs through the queue closes that
pre-existing exposure too.

### 7.2 Serve-side `RunQueue`

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
  cancel(jobId: string): boolean // queued jobs only; running is not killable (§12)
  jobs(): JobView[] // queued + running (done jobs drop out)
}
```

Execution is a promise chain: at most one `execute` in flight; completion
pulls the next job and fires `onUpdate`. Position 0 with an idle queue
starts synchronously — the solo case is byte-equivalent to today's
immediate execution. The queue is also the seam a Phase-4 trigger (cron/
webhook — owner decision, §2) would feed; nothing else would change.

`serve.ts` changes: `executeRequest` becomes the queue's `execute` (same
silent logger, same `inflight` map — mostly idle under serialization but
kept: zero cost, and Phase 3 concurrency reuses it — same `selfIngestSink`

- `serveLogSink`, plus one **per-job sink**
  `{ onRunSummary: s => job.runId = s.run.runId }` so the queue learns the
  runId without any core change). The plain `{ t: 'run' }` WS message (CLI
  delegation) **also enqueues**; when it doesn't start immediately the serve
  streams one
  `{ t:'event', event:{ kind:'run:status', line:'vx: queued behind N run(s) on this serve' } }`
  so a delegated CLI user sees why nothing is happening (`run:status` is an
  existing WireEvent the wire renderer already prints — verify ordering
  before `run:start` renders sanely; test listed in §11). `dist:submit`
  (distributed submissions) does NOT ride the queue — agents execute in their
  own checkouts; there is no shared output tree on the serve to race on.

Behavior change, named: concurrent CLI-delegated runs were previously
concurrent (inflight-dedup joining identical tasks); they now serialize. A
same-input second run waits, then cache-hits everything — similar wall
time, strictly safer for the different-input case that used to race.

### 7.3 Wire — minimal change, reuses the run WS + RunConsole machinery

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
cockpit's consumption path — more wire for no added capability in Phase 1.

One read endpoint for the unified view's live section (poll while
non-empty, 2 s):

```
GET /v1/runs/queue
200 { jobs: [ { jobId, tasks: ['lint'], state: 'queued'|'running',
                position, submittedAt, startedAt? } ] }
```

This also surfaces CLI-delegated runs as rows (state only — their event
stream belongs to the submitting CLI; attaching the dashboard to a foreign
live run needs tagged broadcast, a named Phase-2 option, not required).

### 7.4 The unified Runs view (`#/runs`)

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
  page (recorded graph/flame via RunViz, TaskLogs, why-diff, artifacts)
  that historical rows use. Live and historical drill-down share the visual
  components; the live feed is socket-driven, the historical one SQL-driven.
- `/run` redirects to `/runs`; the capability-aware Home redirect target
  becomes `/runs` unconditionally.

`RunSession.tsx` is extracted from `RunConsole.tsx` (the per-run state
stores, event handler, layout). It keeps consuming `RunGraph` / `Flamegraph`
through their existing props — **those two files are being modified in
parallel and this design specifies nothing about their internals**.

## 8. Artifacts — making the `/v8` store visible

The store exists (trust-scoped, immutable, tag + duration sidecars,
`artifact-store.ts`); the download wire exists (`GET /v8/artifacts/:hash`
with the bearer — TaskLogs already builds exactly this link for a task's
`artifactHash`). Missing: a LIST and a UI.

**One new serve endpoint** (bearer-gated; NOT workspace-gated — artifacts
exist on remote serves too):

```
GET /v1/artifacts?limit=200
200 {
  artifacts: [
    { hash, sizeBytes, storedAt,          // readdir + stat over the store
      durationMs?,                        // .duration sidecar when present
      tier: 'trusted' | 'untrusted',
      task?: { project, task, runId } }   // most-recent runs-table row with
  ]                                       // this hash (ws-resolved db), else absent
}
```

Listing is `readdir` over the requesting principal's READ scopes only
(`readScopes` — an untrusted principal lists its sub-scope ∪ trusted; a
trusted principal NEVER lists untrusted), reusing the exact scope functions
`has()` uses so the list can never leak wider than a GET could fetch. The
task/run join is one batched `SELECT project, task, run_id FROM runs WHERE
hash IN (…)` against the workspace-resolved ingest db — best-effort
provenance (absent for artifacts produced by workspaces this serve never
ingested).

**UI:** `/artifacts` — table (hash, size, age, duration, tier, task link,
run link, download button = the existing bearer-fetched `/v8` GET pattern
from TaskLogs). Run detail's selected-task card generalizes the TaskLogs
artifact link: any task row whose `hash` the store holds (probed via the
list join, no extra endpoint) shows a download action. Pure jsonPage view +
one `data.ts` source; the download button is a small catalog component
(the TaskLogs fetch logic extracted).

Out of scope for Artifacts: retention/quota UI (prune stays CLI/server
policy), artifact CONTENT inspection (tar browsing — real work, no ask),
upload from the UI (the store is written by runs, immutably).

## 9. Insights — one analytics area, zero new endpoints

A views-only reorganization. `/insights` (jsonPage) composes the EXISTING
endpoints: run trends + heatmap (`/v1/trends/*`), cache savings + hit-rate
split (`/v1/cache/savings`, `/v1/cache/hit-split`), flaky tasks with the
Retried column (`/v1/flakiness`), bottlenecks with weekly-savings estimates
(`/v1/bottlenecks`), duration tails (`/v1/history` p50/p99), parallelism
(`/v1/trends/parallelism`), top time-burners + recent failures. Every
row/card links INTO its entity: flaky row → `/tasks/:id`, bottleneck row →
`/tasks/:id`, failure row → `/runs/:runId?task=…`, savings card →
`/cache`. `/trends` and `/bottlenecks` redirect here; the Workspace page
keeps only identity + catalog + pool cards. This is the Nx-Cloud-analytics
answer: same signals (plus the within-run-retry-CONFIRMED flaky signal Nx
observes only via paid re-runs), self-hosted, drill-down into entity pages
instead of dead-end charts.

## 10. Navigation / linking contract

| Route                          | Page                                                                  | Inbound links                                                  | Outbound links                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/runs`                        | unified Runs (spawn + live + history)                                 | nav, Home                                                      | row → `/runs/:id`; compare → `/compare/:id`                                                                         |
| `/runs/:id`                    | Run entity (exists)                                                   | runs rows, task history, `queue:done`, Insights failures       | task row → `/tasks/:proj%23task`; project → `/projects/:name`; `/compare/:id`; artifact download; TaskLogs (exists) |
| `/runs/:id?task=<proj%23task>` | same, selected-task card pre-opened                                   | cache entry "produced by", task history rows, Insights         | (as above)                                                                                                          |
| `/compare/:id`                 | run diff (exists)                                                     | run rows, run detail                                           | both runs' details                                                                                                  |
| `/overview`                    | Workspace entity (relabeled)                                          | nav                                                            | `/projects`, `/runs`, `/insights`, pool card                                                                        |
| `/projects`                    | Projects (catalog ∪ rollups)                                          | nav, workspace                                                 | row → `/projects/:name`                                                                                             |
| `/projects/:name`              | Project entity                                                        | projects rows, run/task back-links                             | task rows → `/tasks/:id`; runs filtered link                                                                        |
| `/tasks`                       | Tasks (catalog ∪ history)                                             | nav, project                                                   | row → `/tasks/:id`                                                                                                  |
| `/tasks/:id`                   | Task entity (config + history + explain + latest entry + flaky badge) | run task rows, project task rows, cache entries, Insights rows | project, `/runs/:runId?task=…` per history row, `/cache/:hash`                                                      |
| `/cache`                       | Cache entries + stats                                                 | nav, task, Insights savings                                    | row → `/cache/:hash`                                                                                                |
| `/cache/:hash`                 | Cache-entry entity (Phase 2)                                          | cache rows, task detail                                        | `/tasks/:id`, producing `/runs/:runId`, `/artifacts` download                                                       |
| `/artifacts`                   | Artifact store list (Phase 2)                                         | nav                                                            | task → `/tasks/:id`; run → `/runs/:runId`; `/v8` download                                                           |
| `/insights`                    | unified analytics (Phase 2)                                           | nav, workspace                                                 | flaky/bottleneck → `/tasks/:id`; failures → `/runs/:id`; savings → `/cache`                                         |

The `?task=` deep link is a small `jr/page.tsx` addition: expose decoded
query params in loader state and seed `/selectedTask` from them (the
run-detail card already binds `/selectedTask` via `useStateBinding`).
Task ids in URLs stay URI-encoded `project#task` — the existing `/tasks/:id`
convention.

## 11. Phasing — each shippable

### Phase 1 — catalog endpoints + unified Runs with queue (the owner's core asks)

Core (export-only):

- `src/index.ts` — the §6.4 exports.
- `tests/package-boundaries.test.ts` — snapshot widening.

Cloud serve:

- `packages/cloud/src/workspace-catalog.ts` — NEW: lock/live resolution
  ladder, mtime-keyed memo, staleness hashing, derived task index.
- `packages/cloud/src/run-queue.ts` — NEW: FIFO executor per §7.2.
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
- rebuild `ui/dist` (build artifact, not committed).

Docs: `docs/cli.md` serve section (+3 endpoints, queue semantics),
`apps/docs` guides/dashboard.md (unified Runs, catalog, positioning per §2).

Tests (Phase 1):

1. serve-catalog: lock-backed list/detail/tasks payload shapes (fixture
   workspace + `vx lock`-written lockfile).
2. serve-catalog: live fallback when no lock (`source: 'live'`, payload
   equals the lock-backed shape for the same fixture).
3. serve-catalog: staleness — edit one config after lock → `staleProjects`
   names it; per-project `stale: true`.
4. serve-catalog: memoization — second request re-reads nothing (fs-read
   count spy).
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
    `createWireRenderer` without breaking output (the §7.2 verify item).
12. serve e2e: socket close on a queued job cancels it; `/v1/runs/queue`
    reflects queued + running states.
13. boundary: package-boundaries snapshot pins the new façade exports.

### Phase 2 — entity-page IA migration + Artifacts + Insights

- `data.ts` sources: `catalogProjects`, `catalogProject`, `catalogTasks`,
  `artifacts`, `cacheEntry`; join helpers in `functions.ts` (catalog ∪
  rollup merge keyed by name/taskId).
- `views/projects.json`, `projectDetail.json`, `tasks.json`,
  `taskDetail.json` — catalog cards + `visible` gates; drill-down
  `rowHref`s per §10; flaky badge on task detail.
- `views/overview.json` → Workspace page (catalog summary + pool card);
  NEW `views/insights.json` absorbing `trends.json` + `bottlenecks.json`
  (+ flaky/savings/hit-split cards); old routes redirect; nav per §4.2.
- NEW `views/artifacts.json` + `views/cacheEntry.json` (`/cache/:hash`).
- Serve: `GET /v1/artifacts` (readdir over the principal's read scopes +
  batched runs-table join, §8).
- Run detail: per-task artifact download action (TaskLogs fetch logic
  extracted to a shared catalog component).
- `jr/page.tsx` — query params into loader state (`?task=` seeding).
- Tests: artifacts list trust scoping (trusted never lists untrusted; an
  untrusted principal lists its sub-scope ∪ trusted; empty store → `[]`);
  artifacts run-join present/absent; source join units; route-redirect
  pins; browser-driven e2e over the built SPA (the established CDP
  verification) covering the drill-down chain run → task → project →
  config and cache entry → run.

### Phase 3 (optional) — non-overlapping concurrent runs

Allow a queued job to start alongside the running one when their planned
node sets are provably disjoint (a `planRun` per submission — cheap, no
exec — intersect task-id sets AND declared output roots; any
`outputs.workspaceFiles` anywhere → never parallel). A scheduling
optimization on top of the same queue, NOT the general fix; true
overlapping concurrency stays with the execution-service roadmap's global
scheduler + output RW-locks. Only build when queue wait times demonstrably
hurt.

### Phase 4 (OPTION — requires an owner decision, see §2)

Scheduled + webhook-triggered runs feeding the same `RunQueue`
(`POST /v1/hooks/:id`, a cron table in the serve). REVERSES the
ci-platform triggers non-goal; do not build without that reversal recorded
in the decision log. Listed so the queue seam is designed once, correctly.

## 12. What's out of scope

- **RunGraph.tsx / Flamegraph.tsx internals** — being modified in parallel;
  this design only consumes their existing props.
- **Killing a RUNNING run from the UI.** Core `run()` has no abort handle
  (`handleSignals: false` delegated runs run to completion); adding
  cancellation is real core plumbing. "Stop" keeps today's semantics: stop
  watching.
- **Attaching the dashboard to a foreign (CLI-submitted) live run's event
  stream.** Needs run-tagged broadcast envelopes; queued-state rows only in
  Phase 1 (named Phase-2 option).
- **Hermeticity card on run detail** — requires persisting `VerifyVerdict`
  in the ingest runs table = the decision log's deferred SCHEMA-bump
  follow-up. Named, not built (this design forbids schema bumps).
- **Distributed (`dist:submit`) runs in the queue** — different execution
  substrate, no serve-local output tree; fairness there is the
  universal-agents workstream.
- **Git-event triggers, hosted runners, secrets, marketplace/DSL** — the
  standing non-goals; §2 reconciles the ambition without reversing them
  (Phase 4 is the flagged exception path).
- **Persisting the queue across serve restarts.**
- **Artifact content inspection / retention UI / UI uploads** (§8).
- **Editing configs from the dashboard.** The catalog is read-only.
- **Any `cache.db` access from the serve** — unchanged standing decision.
- **New telemetry fields / schema bumps** — none: no `CACHE_VERSION`,
  no `SCHEMA_VERSION`, no `TELEMETRY_SCHEMA_VERSION`, no core wire change
  (`protocol.ts` untouched; queue messages are cloud-owned like `dist:*`).

## 13. Open questions

1. **Queue + persistent tasks:** a queued run requesting a persistent task
   executes server-side where persistent children are SIGTERMed at graph
   end (existing delegated-run behavior), so it can't wedge the queue — but
   the UX is a dev server that dies instantly. Refuse `queue:submit` for
   graphs whose requested nodes are persistent, or allow with a warning?
   (Lean: refuse with a clear message; revisit with real demand.)
2. **Agent-pool card data:** `/v1/agents` needs `ws` + `session` params; a
   Workspace-page pool card wants "sessions on this workspace" — a small
   sessions-list read on the registry (Phase 2, optional; skip if the
   registry's session model makes it awkward).
3. **Catalog on a MULTI-workspace serve:** the catalog is inherently
   single-workspace (the colocated one). The `?ws=` param is ignored by
   these routes; the UI shows the catalog only when the selected workspace
   matches the response's `workspaceId` (§6.3 includes it for this).
4. **`/v1/workspace/*` + `/v1/artifacts` over the unix socket:** work for
   free (same fetch handler); just needs test coverage.

## 14. Why this is the right move

- **It's the owner's asks, composed from what exists:** the lock
  (`readLockfile`), the `vx show` loader chain, the run WS + RunConsole
  machinery, the `/v8` store, TaskLogs, the diff/compare/flaky/analytics
  queries — this design is a unification pass, and §5 proves it by mapping
  every shipped capability to its entity page. The only genuinely new
  server logic is the catalog loader, the FIFO queue, and one artifact
  list endpoint.
- **The one-stop-shop ambition lands without breaking the wedge:** run
  experience + operations compete with GHA/Jenkins/Nx Cloud today; the one
  thing that would reverse a standing non-goal (triggers) is fenced as a
  flagged owner decision, not smuggled in.
- **Near-zero core surface:** export-only façade widening; core hot paths,
  wire protocol, schemas, and cache versions are byte-untouched; plain
  `vx run` users pay nothing.
- **The queue converts a UI prohibition into a capability** while CLOSING a
  real pre-existing race (concurrent CLI delegations), without pretending
  to solve concurrent scheduling — that stays honestly deferred to the
  execution-service roadmap.
- **Degradation is uniform:** every catalog surface rides the established
  capabilities pattern; artifacts ride the `/v1/meta` advertisement — the
  remote ingest-only serve keeps working with features simply absent, so
  the plugin-fed architecture stands.
