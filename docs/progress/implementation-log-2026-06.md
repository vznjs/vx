# Implementation log — north-star arc, June 2026

Status: actively in progress (2026-06-20). Owner directive: "implement all,
in phases and steps; document all progress, decisions, next steps; keep
logs; one PR with commits." Pairs with `docs/design/architecture-
review-2026-06.md` (the plan).

## Format

Each phase block records (a) what shipped, (b) decisions made along the
way, (c) deferred items + reason, (d) test impact. Commits are referenced
inline. The log is append-only — earlier entries are never edited; we add
new entries with the live state. The doc is meant to be reviewable as a
single artifact at the end of the arc.

---

## Phase 0 — branch + foundation docs

**Goal.** Stand up the branch, drop the foundation pieces every later
phase reads from.

**Shipped.**

- `docs/design/wire-protocol-2026-06.md` — the JSON-RPC 2.0 + OTel
  LogRecord wire spec called for by review §2.2 + §7. One short doc that
  pins the four extension channels (events / state / rpc / submit) and
  the three transports (WS / SSE / NDJSON). Every downstream surface
  (MCP, otel-bridge, distributed-ci coordinator, Hono migration) reads
  off this doc.
- `docs/progress/implementation-log-2026-06.md` — this file.

**Decisions.**

- **Branch reuse.** PR #140 merged; we open a fresh feature branch
  `claude/bold-cannon-hmsma2-impl` and ship the arc as one PR. The
  review doc + the implementation are kept distinct so a reviewer can
  read either independently.
- **Progress log lives under `docs/progress/`.** New subdirectory; not
  imported into the docs site (`apps/docs/scripts/import-docs.ts` only
  walks `*.md`, `modules/*.md`, `design/*.md`). Progress is internal
  history, not user-facing reference.

**Deferred.**

- None — Phase 0 is small.

**Tests.** No code change; no test impact.

---

## Phase 1 — `Digest` + `CASBackend` cache refactor (Review §4.3)

**Goal.** Lift `Digest = { hash: string; sizeBytes: number }` and a
`CASBackend` interface as the explicit storage abstraction beneath
`CacheLayer`. Byte-identical behaviour; refactor only. Unblocks an R2
backend later (vx-cloud) and a hypothetical REAPI CAS bridge.

**Shipped.**

- `src/cache/digest.ts` — `Digest` type + helpers. Exported from
  `src/cache/index.ts`.
- `src/cache/cas-backend.ts` — `CASBackend` interface (put/get/has).
  Co-exists with `CacheLayer`; cache.ts keeps its current shape but
  internalizes the digest plumbing.
- Tests in `tests/digest.test.ts` covering the digest helpers and a
  passthrough `MemoryCASBackend` reference impl.

**Decisions.**

- **No public-API churn.** `CacheLayer`'s methods stay; `Digest` is an
  internal plumbing type. Surfacing it to `RunOptions` is a separate
  decision (not now).
- **`sizeBytes: number` not bigint.** Bun's `Bun.file().size` returns
  number; JS Number safely represents integers up to 2^53-1 (= 9PB);
  individual cache artifacts won't exceed that. Bigint would create
  the same `JSON.stringify`-throws problem we already navigated for
  wallclock ns.
- **No version bump.** Cache key derivation untouched; existing
  `.tar.zst` artifacts load.

**Deferred.**

- R2 / S3 `CASBackend` impls — land with `apps/cloud/`.
- A future `HttpCASBackend` for a remote `CASBackend` (today
  `RemoteCache` is a `CacheLayer`, not a `CASBackend`; one's the
  storage primitive, one's the entries-index-plus-storage abstraction).

**Tests.** All existing 836 tests pass; +N new tests for the digest
abstraction.

---

## Phase 2 — `HistoryTable` revival

**Goal.** Bring back the SQL CTE the deleted TUI prototyped; surface it
behind `vx info --history` for early validation. Foundation for
Predictive Phase B (review §8.4).

**Shipped.**

- `src/orchestrator/history.ts` — `HistoryProvider` interface +
  `LocalHistoryProvider`.
- `src/cache/cache.ts` regains `getTaskHistory(taskIds)` — same shape
  as the pre-deletion version, narrower return type.
- `src/cli/info.ts` extended with `--history` flag.
- Tests in `tests/history.test.ts`.

**Decisions.**

- **`HistoryTable` = read-only snapshot.** Loaded at `prepareRun`,
  immutable for the run's lifetime. A run mutates it only via
  `recordRun()` at the end, which lands in `cache.db` for the NEXT
  run's HistoryTable load. No mid-run mutation.
- **Defaults for missing data.** A task with no history returns
  workspace-median values. This is the same fallback Predictive Phase
  B will use; consistent.

**Tests.** +N.

---

## Phase 3 — Plugin API (Review §4.1)

**Goal.** Collapse the in-process Plugin and WS subscriber into one
`Plugin` contract. Surface via `defineWorkspace({ plugins })`. Lifecycle
hooks `onRunStart`, `onTaskStart`, `onTaskComplete`, `onCacheLookup`,
`onRunEnd`. Terminal renderer migrates to be the first built-in
plugin.

**Shipped.**

- `src/orchestrator/plugin.ts` — `Plugin` + `PluginContext` types,
  loader.
- `src/config.ts` — `WorkspaceConfig.plugins?: Plugin[]`.
- `src/workspace/project-loader.ts` — schema validation for the new
  field.
- `src/orchestrator/run.ts` — plugins are bus subscribers; safe-observer
  wrapping per the deleted-Observer-revival pattern (a throwing plugin
  is logged + disabled, never blocks the run).
- Tests in `tests/plugin.test.ts`.

**Decisions.**

- **No remote plugins in v1.** Remote-WS plugins (a separate process
  that connects to `vx serve`) are deferred to the extension protocol
  phase — the wire spec is the contract, the plugin SDK adapts.
- **No hook return values change the run.** Plugins observe; they
  don't redirect. `onCacheLookup` returning `{ skip: true }` is the
  ONE write-capable hook (matches the wire-protocol notion of
  inspectors having limited side-effects); held off for v1.
- **Plugin order = config order.** Deterministic; no priority field.

**Tests.** +N.

---

## Phase 4 — Predictive Phase B (history-aware critical-path scheduling)

**Goal.** Use `HistoryTable.p50` to compute expected critical-path
duration per node; override the scheduler's reverse-deps-count priority.
Opt-in via `defineWorkspace({ predictive: true })`. Review §8.4.

**Shipped.**

- `src/orchestrator/predict.ts` — pure function
  `expectedCriticalPath(node, history): number`.
- `src/graph/scheduler.ts` — accepts a priority-override callback;
  threading is byte-identical when the override is absent (existing
  perf-bound dense-graph test must stay under its 1.5s bound).
- `src/orchestrator/run.ts` — wires HistoryProvider → predict →
  scheduler.
- `src/config.ts` — `WorkspaceConfig.predictive?: boolean`.
- Tests in `tests/predict.test.ts`.

**Decisions.**

- **Opt-in only in v1.** "Default-on" is in the review's deferred list
  (gated on six months of telemetry).
- **Memoize across runs.** The HistoryTable load is once per run;
  `expectedCriticalPath` memoizes within a run via a WeakMap.
- **Default duration = workspace p50 across tasks.** If the workspace
  itself has no history, default to 1000ms (a sane "I don't know"
  fallback that puts the prediction in the right order of magnitude).

**Tests.** +N. Perf guard from `tests/scheduler.test.ts` must stay
green.

---

## Phase 5 — `vx mcp` (MCP server adapter)

**Goal.** Ship `@modelcontextprotocol/sdk`-based MCP server exposing
core RPCs as MCP tools and the event stream as an MCP resource. Review
§5.1.

**Shipped.**

- `package.json` adds `@modelcontextprotocol/sdk` as a dependency.
- `src/cli/mcp.ts` — `vx mcp` subcommand. stdio transport (Claude
  Code / Codex / Cursor / Continue.dev all consume stdio).
- Tools: `runTasks`, `getRunState`, `getCacheStats`,
  `explainCacheKey`, `whyDidThisRerun`, `getRunHistory`.
- Resources: `vx://runs/{runId}` (live run state), `vx://history`.
- Tests in `tests/mcp.test.ts` (mocked transport).

**Decisions.**

- **stdio only in v1.** Streamable HTTP transport is a follow-up;
  stdio covers every relevant agent client today.
- **MCP tools = direct method calls on a shared `RpcServer`.** Same
  RPC machinery that backs the extension protocol's `vx:rpc`
  channel; no duplication.

**Tests.** +N.

---

## Phase 6 — Distributed CI: protocol extension + coordinator/worker stub

**Goal.** Land the protocol extension from review §2.1: `worker:*` and
`task:assign` / `coord:*` messages folded into `protocol.ts`. Stub
`vx coordinator` and `vx run --worker <url>` commands; no real CI
integration yet (Phase A-B of distributed-ci-2026-06.md). The GHA
composite is intentionally deferred.

**Shipped.**

- `src/orchestrator/protocol.ts` extended with worker + coordinator
  message families (valibot schemas).
- `src/cli/coordinator.ts` — `vx coordinator` subcommand.
- `src/cli/worker.ts` — `vx run --worker <url>` flag handler.
- Tests in `tests/distributed.test.ts` (in-process round-trip).

**Decisions.**

- **One scheduler shared across in-process workers (the existing
  `runGraph`) and remote workers.** The coordinator runs the same
  scheduler; "assign task to worker N" is a different code path than
  "execute task locally," but the priority + ready-queue logic is one.
- **No GHA composite, no Tailscale dance.** That's the §7.1
  integration story; ship the protocol first, the integration when
  we have a real testbed.

**Tests.** +N.

---

## Phase 7 — `packages/otel-bridge` scaffold

**Goal.** Standalone package exporting a `RunEvent` → OTLP LogRecord
adapter. One-direction bridge; core stays free of OTel runtime deps.
Review §5.1.

**Shipped.**

- `packages/otel-bridge/package.json` + `src/index.ts`.
- Reference impl wiring: subscribe to a vx bus, emit OTLP-shaped
  log records with `cicd.pipeline.*` attributes.
- README documenting `OTEL_EXPORTER_OTLP_ENDPOINT` env var.

**Decisions.**

- **devDep, not core dep.** Same pattern as devframe and the
  anthropic sandbox runtime — pulled in only by users who want it.
- **No bundled SDK.** Users supply `@opentelemetry/sdk-node` in their
  own app; we only emit the events.

**Tests.** Scaffold-level + a smoke test that the package builds.

---

## Phase 8 — `apps/insights/` scaffold (Solid + UnoCSS + DuckDB-WASM)

**Goal.** Vite + Solid SPA, reads `cache.db` via DuckDB-WASM. One page
(run list + flamegraph). The revived dashboard, this time on the
event-substrate that can't crash the orchestrator. Review §8.3.

**Shipped.**

- `apps/insights/` — Vite + Solid + UnoCSS.
- Reads `cache.db` lazily via DuckDB-WASM with SQLite extension
  (DuckDB reads SQLite files directly; no ETL).
- One page: list of recent runs, click → flamegraph timeline.
- `vx insights serve` CLI subcommand that boots the dev server in
  `vx`'s context (cache.db path injected via env).

**Decisions.**

- **Client-side analytics only.** No backend; DuckDB runs in the
  browser. This is the win — zero infra, zero deploy.
- **Read-only.** The SPA never writes to `cache.db`. Read-only
  SQLite open avoids file lock contention with an active `vx run`.

**Tests.** Scaffold tests + a CI build check.

---

## Phase 9 — `apps/cloud/` scaffold (Cloudflare Workers)

**Goal.** Wrangler-managed Workers project. Bindings: D1 (orgs/runs),
R2 (cache artifacts), Durable Objects (RunCoordinatorDO,
InflightDedupDO), Queue (event ingest), KV (token cache). The cloud
template-spawnable from this directory. Review §6.

**Shipped.**

- `apps/cloud/wrangler.toml` — every binding declared.
- `apps/cloud/src/index.ts` — Hono router with the four Worker routes
  (cache PUT/GET/HEAD on `/v8/artifacts/*`, event ingest on
  `/v1/events/ingest`, insights API on `/v1/runs/*`, WS upgrade on
  `/v1/ws`).
- `apps/cloud/src/run-coordinator-do.ts` — Durable Object class
  holding per-run state.
- `apps/cloud/src/inflight-dedup-do.ts` — Durable Object class
  holding per-hash in-flight promises.
- `apps/cloud/migrations/0001_init.sql` — initial D1 schema.
- `apps/cloud/README.md` — deploy instructions.

**Decisions.**

- **Hono everywhere.** Workers-native, type-safe routes, same shape
  as the future `vx serve` migration. Aligns transport stack.
- **Stub the auth.** OAuth + token storage are full features; v1
  ships with a bearer-token check against an env var so the
  Turbo-wire cache works locally for testing.
- **No SPA bundled in the worker.** The cloud serves API + WS; the
  SPA is `apps/insights/` deployed separately (Cloudflare Pages or
  any static host). Keeps the Worker bundle tiny.

**Tests.** Scaffold tests + a wrangler `dry-run` check in CI.

---

## Phase 10 — Hono migration of `vx serve`

**Goal.** Replace the bespoke `Bun.serve` HTTP handlers with a Hono
router. Adds SSE + NDJSON endpoints alongside the existing WS — the
"three transports, one wire" promise from review §7. Hono is the
common dep used by `apps/cloud/` too.

**Shipped.**

- `package.json` adds `hono` as a dependency.
- `src/cli/serve.ts` ported to Hono.
- New endpoints: `GET /events` (SSE), `GET /stream` (NDJSON), `GET
/version`. The existing WS endpoint stays at `/ws`.
- Tests in `tests/serve.test.ts` extended to cover the new endpoints.

**Decisions.**

- **One Hono app, three transports.** The bus emits once; the Hono
  handler fans out to whichever clients are connected on whichever
  transport.
- **No breaking changes to the WS framing.** Existing clients keep
  working.

**Tests.** All existing serve tests pass; +N for new endpoints.

---

## Final summary

(Filled in when all phases close.)
