# Observability + integration architecture — design

> **Status:** proposal (2026-06-28)
>
> **Updates / reconciles (does not contradict without saying so):**
>
> - **Updates** `core-cloud-split-2026-06.md`. That doc inverted three hardcoded
>   hooks into a `VxPlugin` (`backend | cache | eventSink`) and fenced OTel as a
>   §13 open question ("OTel as plugin vs built-in"). This doc resolves that
>   question, **promotes `eventSink` into a first-class, observe-only `telemetry`
>   capability** (a strict superset; `eventSink` stays as a back-compat alias),
>   defines the **canonical export record schema** the split left implicit, and
>   replaces "cloud reads core's `cache.db` directly" with a push-ingest model.
> - **Updates** `event-stream-2026-06.md`. Its `WireEvent` bus is the live
>   substrate; this doc declares a **versioned `TelemetryRecord`** layered on top
>   as THE export contract (the streaming `WireEvent` form is not sufficient
>   alone — see §3 of this doc).
> - **Builds on** `dashboard-tier3-2026-06.md`. The `invocations` header row,
>   `entry_inputs` fingerprints, and `run-context.ts` git/CI/host capture are the
>   raw material for the per-run summary record and the OTel resource attributes.
>
> **Owner's directive (paraphrased):** vx is a CORE that exposes a STABLE API to
> integrate with but NEVER changes behavior; ALL run/build data can flow out via
> OTEL or a manual API through plugins; vx-cloud integrates through a plugin.

## What we're solving

The core/cloud split gave us a typed `VxPlugin` and an `eventSink` capability,
but three gaps remain against the owner's directive:

1. **The observe path is not cleanly guaranteed-neutral.** `VxPlugin` fuses
   behavior-changing capabilities (`backend` reroutes execution, `cache` reroutes
   caching) with the observe-only `eventSink`, under a doc comment that claims
   "plugins observe; they do not redirect" — which is false for two of the three.
   The owner wants the **data/observability path provably unable to change what
   or how tasks run**, distinct from the opt-in behavior capabilities.

2. **There is no canonical, versioned export contract.** Today's exporters
   (`otel-emit.ts`, the cloud `InsightsSink`) each re-derive an ad-hoc shape from
   the raw `WireEvent` stream. The `WireEvent` stream is a _terminal-rendering_
   contract (designed backwards from what the terminal renderer needs), not an
   analytics contract — it lacks the per-run summary, the git/CI resource
   context, and the input fingerprint that every real consumer wants. Each new
   exporter reinvents the projection.

3. **vx-cloud reaches into core's private store.** `packages/cloud/src/cli/serve.ts`
   opens core's `cache.db` directly (`new Cache(cacheDir)`) and runs the 25
   `metrics.ts` queries over it. That couples the cloud service to core's on-disk
   schema (SCHEMA v22, bumped freely as a pre-alpha internal format) and means
   "hosted vx-cloud" is impossible without shipping the developer's cache file.
   The owner wants cloud to **ingest exported data into its own store** and serve
   the dashboard from there; core's `cache.db` becomes private.

OTel is hardcoded in core (`run.ts:80-84` calls `attachOtelEmit(bus)`
unconditionally on every non-embedder run), pulling a `cicd.*`-semconv mapping
into the core orchestrator. The owner wants it to be **a plugin**, with the OTel
SDK isolated out of core's dependency closure.

## Access pattern — what actually flows out, when, and how big

Telemetry is **fire-and-forget, off the critical path, never load-bearing.** The
shapes:

| Signal                | When                  | Per run | Size                          | Consumer cares because                          |
| --------------------- | --------------------- | ------- | ----------------------------- | ----------------------------------------------- |
| **task lifecycle**    | per task: start → end | N tasks | tiny (ids, status, ns, hash)  | live cockpit, OTel spans, flamegraph            |
| **stdout/stderr**     | per chunk             | bursty  | large (build log)             | live log pane; **most consumers don't want it** |
| **run summary**       | once, at `run:end`    | 1       | small (the invocation header) | run history, hit-rate, branch/CI/commit slice   |
| **input fingerprint** | per cache-miss task   | ≤ N     | small per component           | the Develocity "why did this re-run" diff       |
| **cache state snap**  | periodic / on demand  | 1       | medium (entry inventory)      | storage growth, prunable entries, cold entries  |

Two hard observations drive the whole design:

1. **Streaming events ≠ analytics records.** The live `task:start` /
   `task:stdout` / `task:complete` stream is what a _live cockpit_ subscribes to.
   But a run-history dashboard, an OTel trace, or an "insights" upload wants a
   **denormalized per-task record** (status + hash + cache source + cpu/rss +
   durations + the run's git/CI context folded in) plus **one per-run summary**.
   Re-deriving that from the raw stream is exactly the duplicated work in
   `otel-emit.ts` and `InsightsSink`. So the export contract is **two shapes**:
   a streaming `TelemetryRecord` (per event) AND a summary `RunSummaryRecord`
   (per run). A consumer subscribes to whichever it needs.

2. **Cache STATE is not in the event stream — and never will be.** Of the 25
   `metrics.ts` queries, the run/task/invocation analytics are derivable from the
   per-run records (they read the `runs` + `invocations` tables, which are exactly
   the per-task + per-run records persisted). But **eight queries read the
   `entries` table — the cache inventory** (`listCacheEntries`, `getCacheBreakdown`,
   `getStorageGrowth`, `getPrunableEntries`, `getCacheStatsSql`'s entry counts,
   `getCacheSavings`, `getTaskDetail.latestEntry`, `explainCacheKey`). That is
   the _current state of what's on disk_, not a log of events. A run emits "task
   X was a miss, here is its hash"; it does **not** emit "the cache currently
   holds 1,204 entries totalling 8.2 GB, oldest accessed 14 days ago." This
   tension is the crux of §6 and the #1 owner decision.

## Options considered (briefly)

- **(A) Keep `eventSink` as-is; document it as "the observe path."** Rejected:
  it doesn't separate observe-only from behavior-changing capabilities (the
  owner's explicit ask), and it forces every exporter to re-derive analytics from
  the raw stream. No canonical contract.
- **(B) A full "everything bus" plugin protocol** (arbitrary typed channels,
  bidirectional). Rejected: violates principle #1 (explicit over magical) and the
  owner's "minimal surface" lean; speculative. The need is _data out_, not a
  general IPC fabric.
- **(C) New first-class observe-only `telemetry` capability + a versioned
  `TelemetryRecord` contract + push-ingest for cloud.** **Recommended.** It
  cleanly separates the neutral observe path, gives exporters one canonical
  shape, and makes cloud's store independent of core's private `cache.db`.

For the cache-STATE tension (§6) the sub-options are spelled out there.

## Recommendation

A four-layer architecture with a single neutral data boundary:

```
┌──────────────────────────── @vzn/vx (CORE) ──────────────────────────────┐
│  scheduler · cache · exec · hashing                                        │
│      │ emits live RunEvents → EventBus (terminal renderer subscribes)      │
│      │                                                                     │
│  TelemetrySource  ── projects RunEvents → versioned TelemetryRecord +      │
│  (new, core)         RunSummaryRecord; the ONE canonical export shape      │
│      │                                                                     │
│  consults VxPlugin.telemetry(ctx) → TelemetrySink[]  (observe-only, by     │
│      │   construction: a sink receives RECORDS, holds no handle that can   │
│      │   touch the run; a throw/timeout is swallowed)                      │
└──────┼────────────────────────────────────────────────────────────────────┘
       │  TelemetryRecord / RunSummaryRecord  (STABLE, versioned)
       ├────────────────────────┬───────────────────────────┐
       ▼                        ▼                           ▼
  @vzn/vx-otel             @vzn/vx-cloud plugin         (3rd-party sink:
  (telemetry plugin,       telemetry sink →             Slack, Datadog, a
   OTel SDK isolated)      POST to cloud /ingest        local JSON file…)
       │                        │
       ▼                        ▼
  OTLP collector          @vzn/vx-cloud service: ingest → OWN store → dashboard
```

**The neutral boundary is the `TelemetryRecord`/`RunSummaryRecord` contract.**
Core projects its live `RunEvent`s into these records once, in one place
(`TelemetrySource`), and hands them to every registered `TelemetrySink`. A sink
is observe-only **by construction**: its only input is an immutable record; it
holds no `EventBus`, no `Cache`, no `RunRequest`, nothing it could use to alter
the run. Behavior-changing extension stays in the existing `backend`/`cache`
capabilities, which are visually and structurally separate.

This is **behavior-neutral to ship**: the existing `eventSink` capability becomes
a thin adapter over `telemetry` (a back-compat alias), `otel-emit.ts` becomes the
first `telemetry` plugin (env-gated exactly as today), and cloud's `InsightsSink`
becomes a `telemetry` sink that speaks the canonical contract.

## Concrete spec

### 1. Layered architecture + isolation

**Core's responsibility** (unchanged): discover → load → graph → schedule →
cache → exec, and emit the live `RunEvent` stream. Core adds exactly one new
thing: a `TelemetrySource` that projects events into canonical records and fans
them to registered sinks. Core gains **zero** knowledge of OTel, HTTP exporters,
or cloud.

**The dependency rule** (enforced by `tests/package-boundaries.test.ts`, §9):

- Core (`src/**`) imports nothing from any exporter package and nothing from
  `@vzn/vx-cloud`. The OTel SDK is **never** a core dependency — it lives only in
  `@vzn/vx-otel`. (Today `otel-emit.ts` already keeps the SDK out of core's
  closure via dynamic `import('@opentelemetry/...' as string)`; moving it to a
  package makes that structural rather than a convention.)
- Exporter packages depend on `@vzn/vx` via the bare specifier only.
- Core's runtime dep budget stays ≤ today's (the boundary guard's no-reverse-dep
  rule makes a leak structurally impossible).

**The hard isolation guarantee** (three layers of defense):

1. **By construction.** A `TelemetrySink` receives only `TelemetryRecord` /
   `RunSummaryRecord` (immutable, structured-clone-safe values). The
   `TelemetryContext` it is created with carries read-only metadata
   (`workspaceRoot`, `cacheDir` as a string, `warn`) and **no** mutable run
   handle. There is no API path from a sink back into scheduling, caching, or
   exec. Contrast `backend`/`cache`, which return objects core _calls into_ to
   run/cache work — those are the behavior capabilities, kept separate.
2. **Crash isolation.** Each sink's `onRecord` / `onRunSummary` is wrapped in
   try/catch (mirroring `events.ts:63-69` and the existing `subscribeEventSinks`
   isolation). A throwing sink is logged once, disabled for the rest of the run,
   and **never propagates** into the orchestrator.
3. **Time isolation.** Sink delivery is synchronous fan-out of an already-cheap
   record (no I/O on the hot path); the sink is responsible for buffering +
   async flush. A sink that does network I/O in `onRecord` must not block — the
   contract states `onRecord` MUST return promptly (buffer, don't await). The
   `flush()` it exposes runs at `run:end`, also try/caught + time-bounded by the
   sink itself. **A wedged or slow sink cannot stall task exec**, the failure
   mode that killed three prior live-view attempts.

### 2. The stable data contract — `TelemetryRecord` + `RunSummaryRecord`

Two shapes, both versioned, both JSON / structured-clone safe (bigint ns as
decimal strings, the existing `WireEvent` rule). They live in core at
`src/orchestrator/telemetry.ts` and export from `src/index.ts`.

```ts
// src/orchestrator/telemetry.ts  (core; exported from @vzn/vx)

/** Bumped when the record shape changes. Readers MUST check it. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** Identifies which run a record belongs to + its captured context. */
export interface RunContextRecord {
  runId: string // ULID, shared by every record in one `vx run`
  vxVersion: string
  command: string // process.argv-derived, the invocation command line
  requestedTasks: readonly string[]
  cachePolicy: string // compact flags 'lR,lW,rR,rW'
  concurrency: number
  flow: 'focused' | 'broad' | null
  // git / CI / host — straight from run-context.ts (maps to OTel resource attrs)
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string
  arch: string
  tags: Readonly<Record<string, string>> // --tag k=v
}

/** A streaming telemetry record — one per lifecycle event. Superset of the
 *  rendering-oriented WireEvent: carries the run context + the per-task
 *  analytics fields a consumer needs WITHOUT re-deriving from the stream. */
export type TelemetryRecord =
  | { v: number; kind: 'run.start'; run: RunContextRecord; total: number; ts: number }
  | {
      v: number
      kind: 'task.start'
      runId: string
      taskId: string
      project: string
      task: string
      command?: string
      ts: number
    }
  // log chunks are OPT-IN (see record-level filtering below); large + most
  // consumers don't want them. Carried here so a live cockpit CAN ask for them.
  | {
      v: number
      kind: 'task.log'
      runId: string
      taskId: string
      stream: 'stdout' | 'stderr'
      chunk: string
      ts: number
    }
  | {
      v: number
      kind: 'task.end'
      runId: string
      taskId: string
      project: string
      task: string
      status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped' | 'aborted'
      cacheSource: 'miss' | 'local' | 'remote' | 'none'
      exitCode: number
      durationMs: number
      hash?: string
      cpuMs?: number
      peakRssBytes?: number
      wallclockStartNs?: string
      wallclockEndNs?: string
      // The Tier-3 input fingerprint, present on a miss (the diff moat).
      inputComponents?: ReadonlyArray<{ kind: string; name: string; hash: string }>
      ts: number
    }
  | { v: number; kind: 'run.end'; runId: string; ts: number }

/** A per-run SUMMARY record — the denormalized invocation header, emitted once
 *  at run:end. This is exactly InvocationRecord (Tier-3) plus the per-task
 *  outcome list, so an ingesting store can persist a run in one write without
 *  replaying the stream. The "manual API" + cloud ingest primarily speak this. */
export interface RunSummaryRecord {
  v: number
  run: RunContextRecord
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  tasks: ReadonlyArray<{
    taskId: string
    project: string
    task: string
    status: string
    cacheSource: 'miss' | 'local' | 'remote' | 'none'
    exitCode: number
    durationMs: number
    hash?: string
    cpuMs?: number
    peakRssBytes?: number
    wallclockStartNs?: string
    wallclockEndNs?: string
  }>
}
```

**Why a new contract rather than reusing `WireEvent`:** `WireEvent` is the
terminal-rendering contract (`task:start` carries a `TaskView` with `requested` /
`surfaced` / `isGroup` — display flags; it omits the run's git/CI context and the
input fingerprint). A telemetry consumer wants the analytics fields and does NOT
want display flags. Keeping them separate means the terminal renderer and the
exporters evolve independently, and the version sentinel (`v` /
`TELEMETRY_SCHEMA_VERSION`) makes the export contract a real wire format we can
evolve safely — distinct from the internal `WireEvent`, which we change at will
for rendering needs. **The `cacheSource` field is derived once** in core
(`miss`/`local`/`remote`/`none`) from the outcome status, instead of every
consumer re-deciding from `status LIKE 'cache-hit%'`.

**Record-level filtering (the log-chunk problem).** `task.log` records are large
and most sinks (OTel metrics, run-history) don't want them. The
`TelemetrySink.wants?: ReadonlyArray<TelemetryRecord['kind']>` field lets a sink
declare which kinds it receives (default: all except `task.log`). The
`TelemetrySource` checks `wants` before projecting/cloning a record — so a sink
that doesn't want logs pays nothing for them, and the large-payload path is
opt-in.

### 3. The plugin contract for data export — `telemetry`

A new observe-only capability on `VxPlugin`, sibling to (but cleanly separated
from) the behavior capabilities:

```ts
export interface VxPlugin {
  readonly name: string

  // --- BEHAVIOR capabilities (change WHAT/HOW work runs — opt-in) ----------
  backend?(ctx: BackendContext): RunBackend | undefined | Promise<...>
  cache?(ctx: CacheContext): CacheLayer | undefined | Promise<...>

  // --- OBSERVE-ONLY capability (cannot change behavior — by construction) --
  /** Contribute one or more telemetry sinks. Receives canonical records;
   *  holds no run handle. ALL plugins' sinks are active at once (additive).
   *  A throwing/slow sink is isolated and can NEVER fail or stall a run. */
  telemetry?(ctx: TelemetryContext): TelemetrySink | TelemetrySink[] | undefined | Promise<...>

  /** @deprecated alias of `telemetry`. An eventSink is adapted to a
   *  TelemetrySink that re-emits WireEvents (back-compat; see migration §8). */
  eventSink?(ctx: EventSinkContext): EventSink | undefined | Promise<...>

  setup?(ctx: PluginSetupContext): void | Promise<void>
  teardown?(): void | Promise<void>
}

export interface TelemetrySink {
  readonly name?: string
  /** Which record kinds to receive. Default: all except 'task.log'. */
  readonly wants?: ReadonlyArray<TelemetryRecord['kind']>
  /** A streaming record. MUST return promptly (buffer; do not await I/O). */
  onRecord?(record: TelemetryRecord): void
  /** The per-run summary, at run:end. MUST return promptly. */
  onRunSummary?(summary: RunSummaryRecord): void
  /** Drain buffered data. Awaited at run:end (time-bounded by the sink). */
  flush?(): Promise<void>
}

export interface TelemetryContext {
  readonly workspaceRoot: string
  readonly cacheDir: string // a STRING — no Cache handle (isolation)
  warn(message: string): void
}
```

**Multiple sinks compose.** `OTel AND manual-API AND cloud` all run at once:
`telemetry()` may return an array, and every plugin's sinks are registered. Order
= declaration order. A consultation host (`telemetry-host.ts`, sibling to
`plugin-host.ts`) collects all sinks, subscribes the `TelemetrySource` once, and
fans each record to every interested sink under crash isolation.

**Why `telemetry` and not keep `eventSink`:** the owner asked for the observe
path to be "cleanly separated and guaranteed-neutral." `eventSink` (a) is named
for the live stream, not data export, (b) hands the sink raw `WireEvent`s
(rendering shape, no analytics fields), and (c) sits in the same flat list as the
behavior capabilities with a doc comment that overclaims neutrality. `telemetry`
makes the separation explicit in the type, gives the canonical record shape, and
its context structurally cannot reach the run. `eventSink` stays as a documented
alias so nothing breaks.

### 4. First-party OTEL exporter — `@vzn/vx-otel`

A new `packages/vx-otel` package exporting `otel(opts?): VxPlugin`. It contributes
a single `telemetry` sink. The OTel SDK (`@opentelemetry/api`, `sdk-trace-*`,
`exporter-trace-otlp-http`, `sdk-metrics`) is declared **only here** — never in
core, never in cloud.

**Run → trace mapping** (OTel CI/CD + VCS semantic conventions, fed by
`RunContextRecord`):

- **A run = one trace.** `run.start` opens a root span `vx.run`; `run.end`
  closes it. The trace's resource attributes come straight from
  `RunContextRecord`: `cicd.pipeline.run.id` = runId, `vcs.ref.head.revision` =
  commitSha, `vcs.ref.head.name` = branch, `host.name` / `os.type` / `host.arch`,
  `ci` provider as `cicd.provider`. Tags map to `vx.tag.<k>`.
- **A task = a child span** `vx.task` of the run's root span, opened on
  `task.start`, closed on `task.end`. Span attributes: `cicd.pipeline.task.name`
  = taskId, `cicd.pipeline.task.run.result` = status, `vx.cache.source`
  (miss/local/remote), `vx.task.hash`, `vx.task.duration_ms`, `vx.cpu_ms`,
  `vx.peak_rss_bytes`. A `failed` task sets span status ERROR.
- **Span timing** uses `wallclockStartNs`/`EndNs` (already ns-precision relative
  to run t=0) when present; falls back to record `ts`.

**Run → metrics mapping** (a meter `vx`):

- `vx.tasks.total` / `vx.tasks.cache_hits{source=local|remote}` /
  `vx.tasks.failed` — counters, incremented from `RunSummaryRecord`.
- `vx.task.duration` — histogram of task `durationMs` (attribute `cache.source`).
- `vx.run.duration` — histogram of `totalDurationMs`.

**Config:** zero-config via the standard OTel env vars
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_HEADERS`).
The plugin declines (returns `undefined`) when no endpoint is set, so declaring
`otel()` is safe in every environment. The sink's `wants` excludes `task.log`
(logs go to OTel logs only if explicitly enabled via an option) — traces +
metrics are the default, keeping the export lean.

This **upgrades** today's `otel-emit.ts`, which maps every event to a flat OTel
**LogRecord** (not spans, no resource context, no metrics). Traces + metrics +
CI/CD resource attributes are the right model and what observability backends
expect. `otel-emit.ts` is deleted from core; its tested `mapToLogRecord` logic
informs the (richer) span mapping in the package.

### 5. Manual-API exporter — `@vzn/vx-http` (generalizing `InsightsSink`)

A new `packages/vx-http` package exporting `httpTelemetry(opts): VxPlugin`,
contributing one `telemetry` sink that POSTs the canonical records to a
configurable endpoint. This generalizes the cloud `InsightsSink` (which today
uploads raw `WireEvent`s as NDJSON) into a reusable, contract-speaking exporter.

```ts
httpTelemetry({
  url: string,                 // or VX_TELEMETRY_URL
  token?: string,              // Bearer, or VX_TELEMETRY_TOKEN
  format?: 'ndjson' | 'json',  // default ndjson
  mode?: 'stream' | 'summary', // 'summary' = one RunSummaryRecord POST at run:end
                               // 'stream'  = batched TelemetryRecord POSTs
  batchSize?: number,          // stream mode: flush every N records
  timeoutMs?: number,          // default 5000
})
```

- **`summary` mode** (default for run-history use): buffers nothing on the hot
  path, POSTs a single `RunSummaryRecord` JSON body at `run:end`. This is the
  smallest, simplest contract — one HTTP request per run.
- **`stream` mode**: batches `TelemetryRecord`s and POSTs NDJSON
  (`content-type: application/x-ndjson`), flushing on batch size and at `run:end`.
  Used when a consumer wants per-task/live granularity.
- **Never-fail**: all fetch errors swallowed, hard `AbortSignal.timeout`,
  `uploaded`-guard idempotency (the existing `InsightsSink` discipline). A down
  endpoint never affects a run. Auth is a Bearer header.

**This is the contract vx-cloud's ingest endpoint speaks** (§6). The cloud plugin
reuses this sink internally (or composes it) pointed at the cloud's `/v1/ingest`.

### 6. vx-cloud via a plugin (the ingest model) + the cache-STATE tension

**The model.** `@vzn/vx-cloud`'s `cloud()` plugin contributes a `telemetry` sink
that POSTs `RunSummaryRecord`s (and optionally streaming records for the live
cockpit) to the cloud service's new `POST /v1/ingest` endpoint. The cloud service
persists them to **its own store** (a cloud-owned SQLite DB, or Postgres when
hosted — independent of core's `cache.db`). The dashboard's `/v1/*` read APIs
serve from that store. Core's `cache.db` becomes **private to core**; cloud no
longer opens it.

`POST /v1/ingest` accepts a `RunSummaryRecord` (summary mode) or an NDJSON stream
of `TelemetryRecord`s; the ingest writer maps them into the cloud store's `runs`

- `invocations` + `entry_inputs` tables — **the same schema `metrics.ts` already
  queries**, so the existing 17 run/task/invocation queries work unchanged against
  the cloud store. (The metrics queries stay pure functions over a `Database`; only
  the DB they run against changes from "core's cache.db" to "cloud's own store.")

**The hard tension: cache-STATE views (§Access pattern observation 2).** Eight
`metrics.ts` queries read the `entries` table — the live inventory of what's on
disk in the developer's local cache. That state is **not** in the event stream
and is **not** the cloud's to know (the artifacts live on the developer's disk or
in the remote cache CAS, not in cloud's analytics store). Three options:

- **(a) Export periodic cache-STATE snapshots as a record.** Add a
  `cache.snapshot` `TelemetryRecord` (entry count, total bytes, per-project
  rollup, top prunable entries) emitted at `run:end` (cheap: a few aggregate
  queries over the local `entries` table the run just wrote). The cloud ingests
  snapshots into a `cache_snapshots` table; storage-growth and inventory views
  read the latest snapshot per host. **Cost:** the snapshot is per-host
  (multi-machine teams see N snapshots); per-entry inventory (`listCacheEntries`)
  is bounded to a top-K to keep the record small, so the hosted "browse every
  entry" view degrades to "top entries per host."
- **(b) Keep a narrow read-only `insights` pull for cache STATE only.** Run
  data pushes via telemetry; cache inventory stays a local-only read (cloud
  cannot serve it for a remote developer's disk). The hosted dashboard simply
  does not show local cache inventory; a `vx-cloud serve` pointed at a local
  workspace still reads the local `cache.db` for those eight views as a
  documented local-only fallback.
- **(c) Scope the hosted dashboard to run/task analytics; cache-entry inventory
  stays local-only.** The cleanest separation: hosted vx-cloud shows runs,
  invocations, hit-rate, bottlenecks, flakiness, the input-fingerprint diff (all
  push-derivable). Cache **inventory** (what bytes are on which disk, prunable
  entries) is inherently a local concern — surfaced by `vx info` /
  `vx cache prune` and a local `vx-cloud serve`, not the hosted multi-tenant
  dashboard. Hosted "cache" view shows **hit-rate + savings + local/remote split**
  (all push-derivable from run records) but not on-disk inventory.

**Recommendation: (c), with (a)'s `cache.snapshot` record as an OPTIONAL add-on.**
Rationale: cache inventory is genuinely a local/per-host concern — a hosted
multi-tenant dashboard showing "developer alice's laptop holds 8 GB" is low value
and high friction (per-host fan-out, privacy). Run/task analytics — the
competitive moat (the Tier-3 work, the "why did this re-run" diff, hit-rate,
bottlenecks) — are **all push-derivable from `RunSummaryRecord` + the per-task
`inputComponents`**, so the hosted dashboard keeps every analytical feature. The
local `vx-cloud serve` (zero-config, §7) keeps full cache inventory by reading
the local `cache.db` directly — the local path is allowed to be richer than the
hosted path. If a team later wants hosted storage-growth, add the optional
`cache.snapshot` record (option a) behind a `cloud({ snapshotCache: true })`
flag; it's additive and doesn't change the boundary.

**Net:** core's `cache.db` is private. Hosted cloud serves run/task analytics from
its own push-fed store. Local `vx-cloud serve` keeps full fidelity (incl. cache
inventory) via the documented local-read fallback.

### 7. The local zero-config story (THE #1 owner decision)

Today `vx-cloud serve --ui` shows local runs with no plugin, by opening
`cache.db`. In a push-telemetry world, how does local stay zero-friction? The
honest tension: telemetry is **push** (a run must declare a sink to emit), but the
local dashboard wants to show runs **without any config**.

- **Option L1 — local serve runs an ingest endpoint; a default local exporter
  pushes to it.** `vx run` would need a telemetry sink pointed at the local serve
  to populate the dashboard. But a sink only exists if declared in
  `vx.workspace.ts` (no auto-discovery, principle #1) — so a fresh workspace with
  no plugin shows an empty dashboard until the user adds `cloud()`. **Friction:**
  the zero-config local experience regresses; the user must edit config to see
  their own runs.
- **Option L2 — local serve still reads `cache.db` directly as a documented
  zero-config fallback; the push path is the "proper"/hosted path.** A local
  `vx-cloud serve --ui` opens the workspace `cache.db` (as today) and serves the
  full dashboard with zero config and zero plugin. The telemetry push path is
  what feeds a **hosted** (remote, multi-machine, cloud-owned-store) deployment.
  Both coexist: `serve` picks its source — local cache.db when serving a local
  workspace, the cloud ingest store when running hosted.

**Recommendation: L2.** The local dashboard's whole value is "zero-config window
onto your runs" (the decision log's "the cache file IS the API"). Forcing a
plugin declaration to see your own local runs would be a real UX regression for
no gain — locally, the data is already on disk in `cache.db`, and `serve` is
already in the same trust domain as that file. The push path's reason to exist is
**crossing a machine boundary** (laptop → hosted cloud, or CI → team dashboard),
which is exactly where a declared sink + an endpoint + a token make sense. So:

- **Local `vx-cloud serve` reads `cache.db` directly** (zero-config, unchanged) —
  but via a documented, narrow **read-only `LocalInsightsSource`** seam, not by
  importing core internals beyond the already-public `Cache` + `metrics.ts`.
  This keeps the "cloud reads cache.db" coupling, but **only for the local
  zero-config path**, and explicitly as a fallback, not the architecture.
- **Hosted `vx-cloud`** never reads a `cache.db`; it serves only from its
  push-ingested store. Cache inventory views are absent hosted (§6 option c).

**This is the decision the owner must confirm:** local stays a zero-config
cache.db reader (L2) vs. forcing the push path everywhere (L1). The doc
recommends L2; it's the lower-friction, behavior-preserving choice and keeps the
hosted/local split honest (push crosses machines; local reads local).

### 8. Migration — behavior-preserving phases

Every phase keeps `bun src/bin.ts run ci` green and the current dashboard +
Tier-3 features working throughout.

1. **Contract + source in core (behavior-neutral).** Add
   `src/orchestrator/telemetry.ts` (`TelemetryRecord`, `RunSummaryRecord`,
   `TELEMETRY_SCHEMA_VERSION`, `TelemetrySource` projecting `RunEvent`s, deriving
   `cacheSource`, folding in `RunContextRecord`). Add `telemetry-host.ts`
   (consult `VxPlugin.telemetry`, crash-isolated fan-out, `wants` filtering).
   Add the `telemetry` capability to `VxPlugin`; keep `eventSink` as an adapter
   (`eventSink → telemetry` sink that re-projects `TelemetryRecord` back to
   `WireEvent` for back-compat). Export the new types from `src/index.ts` (update
   the boundary snapshot). **No exporter moves yet; no behavior change** — with
   no `telemetry` plugin, nothing emits.
2. **OTel becomes a plugin.** Create `packages/vx-otel` with `otel()`
   contributing the trace+metrics `telemetry` sink. Delete `otel-emit.ts` from
   core and the `attachOtelEmit(bus)` call in `run.ts`. **Behavior note:** OTel
   currently fires with zero config when `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
   after this it requires declaring `otel()` in `vx.workspace.ts`. That is the
   intended de-hardcoding (the owner wants OTel to be a plugin), but it IS a
   behavior change — call it out in the migration guide. (Alternatively, ship
   `otel()` pre-declared in the generated default workspace config so the
   env-var-only experience is preserved; owner decision #3.)
3. **Manual-API exporter package.** Create `packages/vx-http` with
   `httpTelemetry()`; it speaks the canonical contract.
4. **Cloud plugin speaks the contract.** Rework `packages/cloud/src/plugin.ts`'s
   `InsightsSink` (`eventSink`) into a `telemetry` sink that POSTs
   `RunSummaryRecord`s to the cloud service's new `/v1/ingest` (reusing
   `httpTelemetry` internally or composing it).
5. **Cloud ingest endpoint + own store.** Add `POST /v1/ingest` to the cloud
   `serve.ts`; add a cloud-owned store (`runs`/`invocations`/`entry_inputs`
   schema mirrored) the ingest writer populates; point the `/v1/*` read queries
   at it for the **hosted** path. **Keep the local `cache.db` read path** for the
   zero-config local `serve` (§7, L2). Both sources behind a `serve({ source })`
   switch. Existing dashboard + Tier-3 queries are untouched (same SQL, different
   DB).

Phases 1–3 are independent and behavior-neutral. Phase 4–5 move cloud onto the
contract without removing the local cache.db read, so the local dashboard never
regresses.

### 9. What changes where + public surface deltas

**Core (`src/`):**

- **New:** `orchestrator/telemetry.ts` (contract + source), `telemetry-host.ts`
  (consultation). `VxPlugin` gains `telemetry?`; `plugin.ts`/`plugin-host.ts`
  wire it; `run.ts` calls `subscribeTelemetry(...)` in place of the hardcoded
  `attachOtelEmit`.
- **Removed:** `orchestrator/otel-emit.ts` + its `run.ts` call (moves to
  `@vzn/vx-otel`).
- **Public API additions** (update `tests/package-boundaries.test.ts` snapshot):
  `TelemetryRecord`, `RunSummaryRecord`, `RunContextRecord`,
  `TELEMETRY_SCHEMA_VERSION`, `TelemetrySink`, `TelemetryContext`, and the
  `VxPlugin.telemetry` type. `metrics.ts` exports are unchanged (still public,
  now consumed against either DB).

**Cloud (`packages/cloud/`):** `plugin.ts`'s `InsightsSink` → `telemetry` sink
speaking the contract; `serve.ts` gains `/v1/ingest` + a store-source switch
(local cache.db vs. own ingest store). No core internals imported beyond the
public surface.

**New packages:** `packages/vx-otel` (`otel()`), `packages/vx-http`
(`httpTelemetry()`). Both added to the `packages/*` boundary scan; both import
`@vzn/vx` via the bare specifier; the OTel SDK is isolated to `vx-otel`'s
`package.json`. The boundary guard's "no reverse dep" rule extends to assert core
imports none of them.

**Phasing for parallel implementation (disjoint ownership units):**

- **Unit A (core, foundation):** `telemetry.ts` + `telemetry-host.ts` +
  `VxPlugin.telemetry` + `run.ts` wiring + boundary snapshot. Blocks everything;
  do first.
- **Unit B (`@vzn/vx-otel`):** the OTel plugin + delete `otel-emit.ts`. Depends
  on A. Disjoint from C/D.
- **Unit C (`@vzn/vx-http`):** the manual-API plugin. Depends on A. Disjoint.
- **Unit D (cloud):** `InsightsSink` → contract sink; `/v1/ingest` + store
  switch. Depends on A (and reuses C's sink). Disjoint from B.

## What's out of scope

- **No executor plugin protocol.** Tasks stay shell strings (principle #3).
  Telemetry never influences scheduling/caching/exec — that's the whole point.
- **No bidirectional / control telemetry.** Sinks observe; they cannot send
  commands back into the run. (A future "skip this task" hook is the separate,
  already-reserved `onCacheLookup` idea — not telemetry.)
- **No metrics-store query redesign.** `metrics.ts` stays pure SQL; this doc
  changes only WHICH DB it runs against, not the queries.
- **No multi-tenancy / auth model for the cloud ingest store** (Bearer token
  only here; per-org isolation is the deferred Phase 7 of the core/cloud split).
- **No hosted cache-entry inventory** (§6 option c) unless the optional
  `cache.snapshot` record is enabled.
- **No removal of the local `cache.db` read path** — it stays for zero-config
  local serve (§7, L2).
- **No change to the cache key, artifact bytes, or `cache.db` schema** — telemetry
  is a pure side-channel projection of events already emitted.

## Open questions

- **Span SDK weight in `@vzn/vx-otel`.** Trace+metrics pulls a larger OTel
  closure than the current logs-only emit. Acceptable since it's an isolated
  opt-in package, but confirm the trace API surface vs. a lighter
  OTLP-direct-HTTP emit (no SDK) is worth the dependency.
- **`task.log` over the wire.** Default-excluded via `wants`. Confirm no
  first-party sink needs logs by default (the live cockpit subscribes to the live
  `WireEvent` bus directly, not telemetry — so probably none do).
- **Cloud ingest auth.** Bearer token reuses the existing
  `VX_CLOUD_INSIGHTS_TOKEN`. Is that sufficient pre-multi-tenancy, or gate ingest
  behind the Phase-7 auth model from the start?

## Why this is the right move

- **It separates the observe path from the behavior path in the type system**, so
  "telemetry cannot change a run" is a property the compiler + the boundary guard
  enforce, not a comment that overclaims.
- **One canonical, versioned contract** ends the per-exporter re-derivation:
  OTel, the manual API, and cloud all read the same `TelemetryRecord` /
  `RunSummaryRecord`, with the analytics fields + git/CI context pre-folded.
- **The OTel SDK leaves core's closure entirely** (isolated to `@vzn/vx-otel`),
  protecting core's dep budget structurally via the no-reverse-dep guard.
- **Cloud stops depending on core's private on-disk schema** — it ingests the
  stable contract into its own store, making a hosted deployment possible without
  shipping a developer's `cache.db`.
- **It is behavior-neutral to ship** (phases 1–3) and never regresses the
  zero-config local dashboard (L2 keeps the local cache.db read), honoring the
  owner's hard "never change behavior" bar.

## Decisions needed from the owner

1. **Local zero-config story (§7) — the big one.** Confirm **L2**: local
   `vx-cloud serve` keeps reading `cache.db` directly (zero-config, full cache
   inventory) as a documented fallback, while the push-telemetry path is for
   crossing a machine boundary (hosted/CI → team dashboard). The alternative
   (L1, force a declared sink even locally) regresses the zero-config local
   dashboard. Doc recommends L2.

2. **Hosted cache-entry inventory (§6).** Confirm **option (c)**: hosted cloud
   shows run/task analytics + hit-rate/savings (all push-derivable) but NOT
   on-disk cache inventory (inherently local/per-host). Optionally enable the
   `cache.snapshot` record later for hosted storage-growth. Alternative is (a)
   ship snapshots now.

3. **OTel de-hardcoding behavior change (§8 phase 2).** Moving OTel to a plugin
   means `OTEL_EXPORTER_OTLP_ENDPOINT` alone no longer auto-exports — the user
   must declare `otel()`. Accept the behavior change (cleaner), or pre-declare
   `otel()` in the generated default workspace config to preserve the
   env-var-only experience?
