# Per-task logs + artifacts in the dashboard — design

> **Status:** proposal (2026-07-04)
> **Road-to-best-CI item #2** (`ci-platform-2026-07.md` §Deliverable 1, table row 2).
> **Builds on (not re-litigated):** the telemetry contract + `wants` opt-in
> (`observability-architecture-2026-06.md`, `TELEMETRY_SCHEMA_VERSION 2`); the
> push-fed `IngestStore` (serve never reads a workspace `cache.db`); trust
> scopes (`cache-trust-scopes-2026-07.md`); provider-neutral core.

## Decisions up front

1. **Zero core changes.** The neutral surface already exists: `task.log`
   telemetry records are defined, versioned, and opt-in via `TelemetrySink.wants`
   (built for exactly this in 2026-06 and never yet consumed). No
   `TELEMETRY_SCHEMA_VERSION` bump, no `CACHE_VERSION`/`SCHEMA_VERSION` bump,
   no new core file. Everything below lives in `@vzn/vx-cloud`.
2. **Local runs:** the `cloud()` plugin's existing `CloudIngestSink` opts into
   `task.log` + `task.end`, keeps a **bounded tail per task** in memory, drops
   cache-hit buffers at `task.end`, and at flush ships one extra POST
   (`/v1/ingest/logs`) right after the summary POST. Default ON when a cloud is
   connected; `cloud({ logs: false })` / `VX_CLOUD_LOGS=0` opts out.
3. **Delegated runs:** captured **server-side** by a serve-owned sink added to
   `executeRequest`'s `telemetrySinks` — the serve already runs the telemetry
   source for delegated runs; no shipping at all, the bytes are born there.
4. **Distributed runs: Phase 2** (specced in §8, not built this session).
   Verified finding: distributed runs do not appear in run history _at all_
   today (no summary ingest anywhere on the dist path), so their log capture
   has a prerequisite — the scheduler-side summary ingest — that is its own
   increment. The relay point (`DistScheduler.onAgentMessage`) already sees
   every task's output, including the self-agent's, so capture there is free of
   extra network when it lands.
5. **Storage:** a cloud-owned SQLite sidecar per workspace —
   `<ingestDir>/<workspaceId>/logs.db` — with its own version gate. NOT a table
   in core's `Cache` schema (that would bump `SCHEMA_VERSION` for every user's
   local `cache.db` for a cloud-only feature). Tail-capped, zstd-compressed
   over a threshold, pruned by age + a per-workspace byte ceiling.
6. **Cache-hit tasks store nothing; they resolve by hash.** A hit's replayed
   stdout is byte-identical to the executed run's — the read API resolves a
   hit through `task_logs.hash` to the run that produced the bytes and labels
   the provenance. Content-addressed dedup without a CAS.
7. **The failed-task guarantee:** failures stream through the bus and are never
   cached, so stream capture is the _only_ correct source. Failed tails are
   retention-prioritized at every cap (sink budget, server budget) — a
   log-spewing success can never evict a failure's tail.
8. **Artifacts (Phase-1 scope = a download link):** for a task whose hash is
   present in the serve's own artifact store, the log endpoint advertises it and
   the UI offers the `/v8/artifacts/<hash>` download (bearer-fetched). No file
   browser, no per-file extraction.

## What we're solving

Nx Cloud's table-stakes triage flow: a CI run fails → click the failed task on
the run-detail page → read its terminal output in the browser. vx has the data
in flight (the bus streams `task:stdout/stderr`; the cache artifact even stores
stdout for _successful_ tasks) but persists none of it for the dashboard:
`IngestStore` holds run summaries only, and the failed task — the one that
matters most — is **never** cached, so today its output exists only in the CI
job's scrollback.

## Access pattern

| Flow                  | Who has the bytes                        | Volume                       | Reader             |
| --------------------- | ---------------------------------------- | ---------------------------- | ------------------ |
| write (local run)     | the client's bus → cloud sink            | bursty; capped tail per task | one POST per run   |
| write (delegated)     | the serve's own bus                      | same                         | direct store write |
| write (distributed)   | the serve's dist relay (already)         | same                         | Phase 2            |
| read                  | dashboard run-detail, one task at a time | ≤128 KiB per fetch           | click-driven, rare |
| the read that matters | a FAILED task minutes after CI           | tail                         | must always exist  |

Reads are rare, tiny, and point (one task). Writes are once per run, bounded.
Retention dominates storage. This shape wants a small indexed store with caps —
not streaming infrastructure, not object storage.

## Options considered (briefly)

- **Read logs back from cache artifacts server-side** (the `/v8` store already
  carries `stdout`). Rejected as the primary path: failed tasks are never
  cached (the _whole point_ of the feature), artifacts only exist when the
  remote-cache rung is connected and the task is cacheable, and extracting
  tar.zst per page view couples the dashboard to the cache transport + trust
  scoping. Kept as a bonus: the hash-dedup idea (hits resolve to the executed
  run's row) and the artifact download link.
- **Embed logs inside `RunSummaryRecord`.** Rejected: core builds the summary;
  putting logs in it moves log buffering into core's hot path and bloats the
  canonical contract every other sink receives. The sink owns its buffering.
- **A `task_logs` table in core's cache.db schema.** Rejected: core stays
  provider-neutral; a cloud dashboard feature must not bump core's
  `SCHEMA_VERSION` (which drops/recreates every user's local index).
- **Files on disk per task** (`logs/<runId>/<taskId>`). Rejected: taskIds
  contain `#` and `/` (scoped package names) so paths need encoding; caps and
  retention need size bookkeeping SQLite gives for free; atomicity and
  idempotency are manual. SQLite BLOBs at ≤128 KiB per row are the easy case.
- **Chosen:** stream-capture at the two places the bytes already flow (client
  sink, serve sink), bounded tails, a cloud-owned `logs.db` sidecar, two serve
  routes, one UI component.

## Concrete spec

### 1. The shared capture primitive — `packages/cloud/src/task-log-capture.ts` (new)

One class used by the client sink, the serve sink, and (Phase 2) the dist
scheduler, so the capping rules can't drift:

```ts
export const LOG_WIRE_VERSION = 1

// Caps. Char-counted (UTF-16 units) on the capture side as a cheap proxy;
// the store records true stored bytes. All compile-time constants — no
// client-side knob sprawl in Phase 1.
export const TASK_LOG_TAIL_CHARS = 128 * 1024 // per task, merged streams
export const RUN_LOG_BUDGET_CHARS = 4 * 1024 * 1024 // per run, shipped total

export interface TaskLogEntry {
  taskId: string
  /** The task's cache key when known — the hit→executed-run resolution key. */
  hash?: string
  status: 'success' | 'failed'
  /** Merged stdout+stderr in arrival order (what a terminal shows), tail-capped, ANSI preserved. */
  content: string
  /** Chars emitted before capping. */
  charsFull: number
  /** Chars dropped from the head; 0 = complete. */
  truncatedHeadChars: number
}

export interface TaskLogBundle {
  v: typeof LOG_WIRE_VERSION
  runId: string
  workspaceId: string
  tasks: TaskLogEntry[]
}

/**
 * Per-run bounded capture. append() keeps a chunk LIST + running char count
 * per task, evicting whole chunks from the head past TASK_LOG_TAIL_CHARS
 * (no string concatenation until finish — chunks are retained by reference,
 * so a cache-hit replay costs one array push, zero copies).
 */
export class TaskLogBuffer {
  append(taskId: string, chunk: string): void
  /**
   * task.end: decide retention. cacheSource !== 'miss'  → DROP the buffer
   * (the executed run already stored these bytes; hits resolve by hash).
   * 'skipped'/'aborted' → drop. success/failed miss → RETAIN the tail.
   * Retention budget: a running total of retained chars; when adding a task
   * would exceed RUN_LOG_BUDGET_CHARS, evict oldest retained SUCCESS tails
   * first; failed tails are evicted only by newer failed tails (oldest
   * first) once failures alone exceed the budget.
   */
  finish(taskId: string, status: TaskStatus, cacheSource: CacheSource, hash?: string): void
  /** Everything retained, failures first, ready to ship/store. */
  drain(runId: string, workspaceId: string): TaskLogBundle
}
```

Memory bound while running: `RUN_LOG_BUDGET_CHARS` (retained-completed) +
`concurrency × TASK_LOG_TAIL_CHARS` (in-flight) — a log-spewing task cannot
OOM the client or the serve.

### 2. Capture path — LOCAL runs (`packages/cloud/src/plugin.ts`)

`CloudIngestSink` changes:

- `wants` goes from `[]` to `['task.log', 'task.end']` **when logs are enabled**
  (default on; `cloud({ logs: false })` or `VX_CLOUD_LOGS=0` reverts to `[]`).
- `onRecord`: `task.log` → `buffer.append(taskId, chunk)`; `task.end` →
  `buffer.finish(taskId, status, cacheSource, hash)`.
- `flush()`: after the existing summary POST, one `POST /v1/ingest/logs` with
  the drained `TaskLogBundle` (skipped when empty — the all-hit warm run ships
  nothing). Same discipline as the summary: clearable 10s timer, all errors
  swallowed + warned, `uploaded` idempotency guard, socket-then-TCP fallback.
  Summary first, logs second (same flush, sequential) so the run row normally
  exists when logs land; the store tolerates either order (orphan log rows are
  harmless and age out).

**Perf accounting against the laws.** Plain `vx run`, no cloud connected:
`resolveConnection` returns undefined → sink never exists → `wantsLog` stays
false in `createTelemetrySource` → `task:stdout` events return before
projecting — **byte-identical, the existing invariant, already pinned.** With a
cloud connected: per executed-task chunk, one record object + one array push
(chunk retained by reference); per cache hit, the replay is ONE chunk (the
whole stored-stdout string, already in memory from the SQL row — see
`execute-task.ts:635`), so a warm all-hit run pays one push + one map-drop per
task and ships zero log bytes. No new spawns, no I/O, no hashing — nothing on
the path that derives keys or restores outputs.

**Why the client can't read logs from disk instead:** the failed task's output
is never cached (only successes save), and the sink deliberately holds no
`Cache` handle (`TelemetryContext.cacheDir` is a string by construction).
Stream capture is the only source that always has the failure.

**Privacy note (documented, not blocked):** run summaries were metadata; log
tails are program output and may echo secrets. Precedent: cache artifacts
already carry full stdout to the same serve for every cacheable success, under
the same bearer + trust scoping. The opt-out is the control.

### 3. Capture path — DELEGATED runs (`packages/cloud/src/cli/serve.ts`)

Delegated runs execute _on the serve_ via `executeRequest(..., [selfIngestSink])`
— the serve already hosts the telemetry source for them, and the client never
runs core `run()` (so there is no client push and **no double-shipping by
construction**). Add one shared, stateless-per-run sink beside `selfIngestSink`:

```ts
// serve.ts — one instance for the serve's lifetime; records carry runId,
// so concurrent delegated runs multiplex cleanly.
const serveLogSink: TelemetrySink = makeServeLogSink(ingest)
// wants: ['task.log', 'task.end']
// onRecord: route into a per-runId TaskLogBuffer (created on first record)
// onRunSummary: drain that runId's buffer → ingest.ingestLogs(bundle) → delete buffer
// (an abandoned buffer — run crashed before summary — is dropped by a
// 15-min sweep alongside the existing timers)
```

No HTTP hop, no encoding: the bundle goes straight into the store.

### 4. Versioning — additive everywhere

- **`TELEMETRY_SCHEMA_VERSION` stays 2.** `task.log` records exist at v2 with
  exactly the fields needed (`runId`, `taskId`, `stream`, `chunk`, `ts`);
  `task.end` carries `status`/`cacheSource`/`hash`. Consuming an existing
  opt-in record is not a contract change.
- **`LOG_WIRE_VERSION = 1`** on the `POST /v1/ingest/logs` body (a new cloud
  wire format → its own sentinel; the serve 400s an unknown `v` naming both).
- **`logs.db` schema version 1** in its own `logs_meta` table; the gate
  drop-recreates on mismatch (pre-alpha) with the same loud warning the ingest
  store gives — this is history, not cache.
- `/v1/ingest` and `RunSummaryRecord` are untouched.

### 5. Storage — `packages/cloud/src/log-store.ts` (new) + `IngestStore` wiring

One `LogStore` per workspace at `<ingestDir>/<workspaceId>/logs.db`, opened
lazily by `IngestStore` next to the existing per-workspace `Cache` (same
`WORKSPACE_ID_RE` validation; ids are already path-safe there).

```sql
CREATE TABLE IF NOT EXISTS task_logs (
  run_id         TEXT    NOT NULL,
  task_id        TEXT    NOT NULL,
  hash           TEXT,                            -- cache key when known
  status         TEXT    NOT NULL,                -- 'success' | 'failed'
  codec          TEXT    NOT NULL DEFAULT 'plain',-- 'plain' | 'zstd'
  content        BLOB    NOT NULL,
  chars_full     INTEGER NOT NULL,
  bytes_stored   INTEGER NOT NULL,
  truncated_head INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_logs_hash    ON task_logs(hash);
CREATE INDEX IF NOT EXISTS task_logs_created ON task_logs(created_at);
```

- **Write** (`ingestLogs(bundle)`): one transaction, `INSERT OR IGNORE` per
  task (PK = idempotency; a re-delivered bundle adds nothing). Server-side
  re-truncation to `TASK_LOG_TAIL_CHARS` / `RUN_LOG_BUDGET_CHARS` regardless of
  what the client claims — caps are never trusted from the wire. Content ≥ 4 KiB
  is stored zstd (`Bun.zstdCompressSync`), smaller stays plain.
- **Read**: `logFor(runId, taskId)` (decompress on read), and
  `latestByHash(hash)` for the hit resolution.
- **Bounds** (the law): request body cap 16 MiB (413 above it, checked on
  content-length before reading); per-workspace ceiling
  `VX_CLOUD_LOG_MAX_BYTES` (default 512 MiB) — when `SUM(bytes_stored)`
  exceeds it, delete oldest runs' rows until under; age retention
  `VX_CLOUD_LOG_RETENTION_DAYS` (default 30). Both pruned opportunistically on
  ingest, throttled to once per 5 minutes. Orphan rows (summary never landed,
  or the run store was schema-wiped) age out with everything else.
- `IngestStore.close()` closes log stores too.

### 6. Serve API

One read route (no index endpoint — the UI fetches per selected task and a 404
is a legitimate answer), one write route:

```
POST /v1/ingest/logs                     body: TaskLogBundle
  → { ok: true, stored: n } | 400 (bad shape / unknown v) | 401 | 413
  Behind the bearer like every /v1 write; workspace routed by body.workspaceId
  (validated), consistent with /v1/ingest.

GET /v1/runs/:runId/logs/:taskId?ws=     (taskId URI-encoded, /(.+)/ pattern
                                          like /v1/tasks/)
  → 200 TaskLogResponse | 404 { error }
```

```ts
interface TaskLogResponse {
  runId: string
  taskId: string
  /** 'executed' = this run's own capture; 'cache' = resolved via hash to the
   *  run that actually produced the bytes (this task was a cache hit). */
  source: 'executed' | 'cache'
  /** The producing run, when source === 'cache'. */
  refRunId?: string
  status: 'success' | 'failed'
  content: string
  charsFull: number
  truncatedHeadChars: number
  /** Present when the serve's own artifact store holds this task's artifact —
   *  the UI renders a download link to /v8/artifacts/<hash>. */
  artifactHash?: string
}
```

Resolution order in the handler: (1) direct `task_logs` row for
`(runId, taskId)`; (2) else read the task's row from the run store
(`getRun`-shaped lookup) — if it was a cache hit with a hash, return
`latestByHash(hash)` as `source: 'cache'` + `refRunId`; (3) else 404
(`no logs captured`). Artifact presence via the existing
`artifacts.has(hash, principal)` — trust-scoped by the requester's principal,
so an untrusted reader is never shown a trusted-scope artifact it can't fetch.

### 7. UI (`packages/cloud/ui`)

- `api.ts`: `getTaskLog(runId, taskId): Promise<TaskLogResponse | null>`
  (existing origin/token/workspace plumbing; 404 → null).
- `jr/components.tsx`: new self-contained catalog component **`TaskLogs`**
  (same pattern as `LiveActivity` — internal `createResource` keyed on props,
  since named data sources load once per page and can't refetch on
  `/selectedTask` writes). Renders: monospace scrollback (ANSI stripped
  client-side like `RunConsole`), a truncation banner
  (`… earlier output truncated (N KiB dropped)`), a provenance line for
  `source: 'cache'` (`output captured on run <refRunId> — this task was a
cache hit`, run link), an artifact download link when `artifactHash` is set
  (bearer fetch → blob → save, since `/v8` needs the Authorization header),
  loading/empty/error states (`no logs captured for this task` for 404s —
  honest for pre-feature runs and skipped tasks).
- `views/runDetail.json`: the existing selected-task card gains a `TaskLogs`
  child bound to `/params/id` + the selected task's id. No new route, no new
  data source. Registry + `catalog.ts` entry for the component; rebuild the
  committed `ui/dist`.

### 8. DISTRIBUTED runs — Phase 2 (specced, not this session)

**Verified gap:** a distributed run ingests no summary anywhere — agents'
scoped runs decline telemetry (`VX_CLOUD_AGENT=1` sentinel, correctly), the
submitter's core `run()` never executes (the backend replaces it), and
`DistScheduler` never touches `IngestStore`. So distributed runs are absent
from run history entirely; logs have nothing to attach to. Phase 2 fixes both
at once, server-side, with zero added network:

- `DistScheduler` feeds a `TaskLogBuffer` at the exact relay points that
  already see every chunk (`onAgentMessage` `agent:stdout/stderr` — the
  self-agent relays through the same messages, so submitter-local tasks are
  covered too), and calls `finish()` on `agent:done` / store-prune outcomes.
- At `checkFinish`, build a minimal `RunSummaryRecord` — `runId =
submissionId` (already a UUIDv7), context synthesized from
  `DistSubmitMessage.request` (command/tags/cache/concurrency ride the
  request since Tier-3 Phase B) + `commitSha` + `workspaceId` — and call
  `ingest.ingest(summary)` + `ingest.ingestLogs(bundle)`.
- Client sinks stay out of it: the submitter process has no core run, agents
  keep declining. No double-shipping possible.

This is deliberately staged: it changes the dist scheduler's finish path and
needs its own summary-fidelity decisions (e.g. `workspaceName`, `flow`), and
Phase 1 is already a full session.

### 9. The failed-task guarantee, end to end

- Failures stream through the bus like everything else and are **never**
  cached → captured by the sink tails (local) or the serve sink (delegated).
- `TaskLogBuffer.finish` retains every failed tail; budget eviction removes
  success tails first, always.
- The summary + logs flush happens at `run:end` regardless of `exitOk`
  (telemetry-host emits the summary for failed runs today — pinned behavior).
- Residual (accepted, documented): a hard kill of the vx process mid-run skips
  flush — those logs are lost exactly as the summary already is. Delegated
  runs don't share this residual (the serve outlives the client).

## Implementation plan (Phase 1, one session)

| #   | File                                                                                                            | Change                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/cloud/src/task-log-capture.ts` (new)                                                                  | `LOG_WIRE_VERSION`, caps, `TaskLogEntry`/`TaskLogBundle`, `TaskLogBuffer`                                                                                                                            |
| 2   | `packages/cloud/src/log-store.ts` (new)                                                                         | `LogStore` (schema v1 gate, `ingestLogs`, `logFor`, `latestByHash`, prune)                                                                                                                           |
| 3   | `packages/cloud/src/ingest-store.ts`                                                                            | lazy per-workspace `LogStore` (`logs(wsId)`), close wiring                                                                                                                                           |
| 4   | `packages/cloud/src/plugin.ts`                                                                                  | `CloudPluginOptions.logs?: boolean`; `CloudIngestSink` wants/onRecord/flush (summary POST then logs POST); `VX_CLOUD_LOGS` gate                                                                      |
| 5   | `packages/cloud/src/cli/serve.ts`                                                                               | `serveLogSink` beside `selfIngestSink`; `POST /v1/ingest/logs`; `GET /v1/runs/:id/logs/:taskId` (+hash fallback + artifact flag); env knobs `VX_CLOUD_LOG_RETENTION_DAYS` / `VX_CLOUD_LOG_MAX_BYTES` |
| 6   | `packages/cloud/ui/src/api.ts`, `jr/components.tsx`, `jr/catalog.ts`, `jr/renderer.tsx`, `views/runDetail.json` | `getTaskLog`, `TaskLogs` component, selected-task card wiring; rebuild `ui/dist`                                                                                                                     |
| 7   | docs                                                                                                            | `guides/dashboard.md` logs section (incl. privacy note + opt-out), `docs/cli.md` serve env knobs, `docs/modules/` cloud page touch-up                                                                |

**Tests** (all in `packages/cloud/tests/`, plus one plugin pin):

- `task-log-capture.test.ts` — tail eviction drops head chunks and counts
  `truncatedHeadChars`; hit/skip/abort buffers dropped at finish; failed
  retained; run-budget evicts success-before-failed, oldest-first; drain
  orders failures first; zero-retention run drains empty.
- `log-store.test.ts` — schema gate recreates + warns; `ingestLogs` idempotent
  (re-POST adds nothing); server-side re-truncation of an over-cap entry;
  zstd/plain codec round-trip; age prune; byte-ceiling prune deletes oldest
  runs first; orphan bundle (no run row) stores and ages out.
- `serve.test.ts` additions — `POST /v1/ingest/logs` 401 without bearer, 400 on
  unknown `v`, 413 over body cap; `GET .../logs/:taskId` returns stored
  content; cache-hit task resolves via hash to `source:'cache'` + `refRunId`;
  unknown task → 404 shape; `artifactHash` present iff the store holds it
  (trust-scoped: untrusted principal doesn't see a trusted-only artifact).
- `plugin.test.ts` additions — sink with logs enabled ships summary POST then
  logs POST (shape-pinned); warm all-hit run ships NO logs POST; `logs: false`
  / `VX_CLOUD_LOGS=0` → `wants` stays `[]` (the wantsLog-off pin — the
  zero-projection guarantee); flush never throws on a down endpoint.
- delegated e2e (`serve.test.ts` or `backend` suite) — a real delegated run
  with one failing task → its stderr tail readable via the GET route.
- Manual verify per repo convention: rebuild `ui/dist`, drive run-detail over
  CDP — select a failed task, read its output; select a hit, see provenance;
  0 console errors.

Gate: cloud suite + core suite green (core is untouched — expect zero core
test churn), lint+oxfmt clean.

## What's out of scope

- **Live streaming** — the cockpit already streams over WS/SSE; this is
  persisted history only.
- **Full un-truncated logs / object-storage backend** — tails only, SQLite
  only. Revisit only if real usage outgrows the caps.
- **Distributed-run capture + dist-run history ingest** — Phase 2 (§8).
- **Log search / indexing / per-line timestamps / stdout-stderr split panes**
  — merged arrival-order text, filterable client-side later if wanted.
- **Artifact browsing** (per-file listing/extraction) — download link only.
- **Core changes of any kind** — no new telemetry kinds, no summary fields,
  no CLI flags.
- **Multi-tenant quotas/auth beyond the existing bearer + trust scopes.**

## Over-engineering to avoid (explicit)

- No streaming/chunked log ingest during the run (one POST at flush is enough;
  live view is the cockpit's job).
- No CAS or content-addressed log store — the `hash` index column IS the dedup.
- No ANSI-fidelity terminal emulator in the dashboard (strip like `RunConsole`).
- No client-side knobs beyond the single on/off (caps are constants until
  someone hits them).
- No log levels/parsing/grouping — bytes in, bytes out.
- No virtualized viewer for huge logs — tails are ≤128 KiB by construction.
- No second copy for cache hits — resolve by hash, label the provenance.

## Why this is the right move

- **Core stays untouched** — the 2026-06 telemetry design anticipated exactly
  this consumer (`task.log`, opt-in via `wants`); the first real consumer
  validates the contract instead of extending it.
- **Zero-overhead law holds structurally**: no connection → no sink → the
  `wantsLog` gate short-circuits before any projection; warm runs with a
  connection pay one array push per task and ship nothing.
- **It captures the only bytes that can't be recovered any other way** —
  failed-task output — and prioritizes them at every cap.
- **Storage is bounded at four layers** (per-task tail, per-run budget,
  request body cap, per-workspace ceiling + age), so a log bomb degrades to
  truncation, never to serve OOM or unbounded SQLite growth.
- **It reuses every existing seam** — the ingest store's per-workspace layout,
  the serve's auth/trust plumbing, the `/v8` store for artifacts, the
  self-contained-widget UI pattern — one new wire route, one new sidecar DB,
  one new component.

## Open questions

- Should the per-task tail default be raised for failed tasks specifically
  (e.g. 512 KiB failed / 128 KiB success)? Cheap to add inside
  `TaskLogBuffer.finish` if triage shows failure tails getting cut.
- Phase 2's synthesized dist-run `RunContextRecord`: extend
  `DistSubmitMessage` with `workspaceName`/`flow` (additive, no
  DIST_PROTOCOL bump needed) or accept nulls?
