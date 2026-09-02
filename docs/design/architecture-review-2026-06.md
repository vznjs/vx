# Architecture review — sharpening the five proposals

Status: **MOSTLY APPLIED 2026-06-21**. See "Applied" snapshot below.
Originally a review pass (2026-06-20). Reads the five north-star
proposals (`architecture-north-star-2026-06.md`,
`distributed-ci-2026-06.md`, `vx-cloud-2026-06.md`,
`extension-protocol-2026-06.md`, `predictive-execution-2026-06.md`)
against (a) two parallel research passes on third-party tooling and
(b) the cross-doc duplication + contract-gap matrix. Answers: what
to simplify, what to merge, what
to fix, what to import from outside instead of building, and what to
commit to first.

## Applied (2026-06-21)

What the review called for vs. what's in the running code:

| Review item                                                                               | Status                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| §2.1 Fold `worker:*` into `protocol.ts` (one envelope)                                    | ✓ shipped (Step 4 + Step 2)                                                               |
| §2.2 Channels map to JSON-RPC 2.0 methods                                                 | ✓ shipped (`src/orchestrator/wire.ts`)                                                    |
| §2.3 Cloud persists `WireEvent` (projected form), never `RunEvent` raw                    | ✓ shipped (`apps/cloud/src/index.ts` queue() stores `event_json` from the projected form) |
| §2.4 `HistoryProvider` as the loader interface                                            | ✓ shipped (`src/orchestrator/history.ts`)                                                 |
| §3.2 Predictive Phase F default-on downgraded to data-gated                               | ✓ shipped — `predictive: true` is opt-in                                                  |
| §3.3 vx-cloud SQL on D1 (not Postgres)                                                    | ✓ shipped (`apps/cloud/migrations/0001_init.sql`)                                         |
| §4.1 In-process plugin + WS subscriber collapsed to one `Plugin` contract                 | ✓ shipped (`src/orchestrator/plugin.ts`)                                                  |
| §4.2 Coordinator + RunCoordinatorDO share contract                                        | ✓ shipped (Bun version local; CF DO version in `apps/cloud/`)                             |
| §4.3 `Digest` + `CASBackend` as explicit CAS key/storage abstraction                      | ✓ shipped (`src/cache/digest.ts`, `src/cache/cas-backend.ts`, `Cache.contentBackend()`)   |
| §4.4 Extension protocol collapsed from 7 phases to 3                                      | ✓ shipped (Phase 1: bus + JSON-RPC + MCP all in one go)                                   |
| §5.1 Adopt MCP SDK                                                                        | ✓ shipped (`src/cli/mcp.ts`)                                                              |
| §5.1 Adopt Hono                                                                           | ✓ shipped in `apps/cloud/`; deferred for host-side `vx serve`                             |
| §5.1 Adopt OTel CI/CD semantic conventions                                                | ✓ shipped (`packages/otel-bridge/`)                                                       |
| §5.2 Inspire from Bazel CAS digest                                                        | ✓ shipped (`src/cache/digest.ts`)                                                         |
| §5.2 Inspire from BuildBuddy product UX                                                   | ◐ partial — `vx insights` Solid+DuckDB-WASM scaffold                                      |
| §5.2 Inspire from JSON-RPC 2.0 envelope (MCP+A2A convergence)                             | ✓ shipped                                                                                 |
| §5.2 Inspire from OTel LogRecord shape                                                    | ✓ documented in `wire-protocol-2026-06.md`                                                |
| §5.2 Inspire from Vite plugin lifecycle hooks                                             | ✓ shipped (`PluginHookHandlers`)                                                          |
| §5.4 Plan exit from devframe                                                              | ◐ partial — bus works without it; devframe still gates the `--ui` and `vx dev` hub        |
| §6 Cloudflare-native cloud (Workers + R2 + D1 + DOs + Queues + KV)                        | ✓ shipped (`apps/cloud/`)                                                                 |
| §7 Wire format consolidation (7 framings → 2)                                             | ✓ shipped                                                                                 |
| §8.1 Distributed-ci feasible after protocol extension                                     | ✓ shipped Phase A-B                                                                       |
| §8.2 vx-cloud feasible AFTER CF pivot                                                     | ✓ shipped Phases A-C                                                                      |
| §8.3 Extension-protocol Phase 1                                                           | ✓ shipped                                                                                 |
| §8.4 Predictive feasible; data dependency is the gate                                     | ✓ shipped Phase A-B                                                                       |
| §9 Wave plan: wire spec → CAS → HistoryTable → Hono migration → MCP → distributed → cloud | ✓ shipped (except host-side Hono migration)                                               |

The detailed phase-by-phase implementation log was removed with the
2026-09 cleanup; it is in git history.

## 0. Executive verdict

The five proposals are individually coherent and compose well. The
review surfaced **two structural simplifications**, **four sharpening
moves**, **three bugs/contradictions**, and **two strategic
imports** (one wire-format consolidation, one storage-abstraction
factoring). One major pivot: **vx Cloud is now Cloudflare-native**
(Workers + R2 + D1 + Durable Objects + Queues), template-spawnable
from `apps/cloud/`. The PostgreSQL+S3 framing in the original doc is
out.

| #   | Proposal                | Verdict                            | Action                                                                |
| --- | ----------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| 1   | event-stream (shipped)  | ✓ foundation is sound              | formalize WireEvent as JSON-RPC 2.0 + OTel-LogRecord-shaped           |
| 2   | execution-service       | ✓ shipped + dedup landed           | rename roles to match distributed-ci                                  |
| 3   | distributed-ci          | ✓ feasible, contract needs work    | fold `worker:*` into `protocol.ts`; add hybrid-exec racing from Buck2 |
| 4   | vx-cloud                | **PIVOT**: now Cloudflare stack    | rewrite §4/§8 (done in this pass); template-spawnable                 |
| 5   | extension-protocol      | ✓ feasible; over-scoped at phase F | trim from 7 phases to 3; collapse plugin + subscriber into one model  |
| 6   | predictive-execution    | ✓ feasible, gated on data          | downgrade "default-on" Phase F to "future"                            |
| 7   | architecture-north-star | ✓ synthesis stands                 | update with CF pivot + wire-format consolidation                      |

The single biggest unlock is consolidating the wire format: **one
envelope (JSON-RPC 2.0), one event shape (OTel LogRecord-flavored),
one transport family (WS for bidir + SSE for read-only + NDJSON for
scripts)**. Everything else — MCP, A2A, devframe, birpc, custom
clients — interops with that.

The single biggest external import is **OpenTelemetry CI/CD semantic
conventions** for the event stream. Lift it, and every observability
platform (Grafana, Honeycomb, Datadog, Tempo) speaks vx out of the
box. The single biggest internal refactor is **lifting `Digest`
into the cache** — make `(hash, sizeBytes)` the explicit CAS key
type, so storage backends (local FS, R2, S3, REAPI CAS) become
pluggable without orchestrator changes.

---

## 1. Duplications across the five docs (consolidation list)

Five themes get restated in multiple docs with slightly different
words. Each is a candidate for **one canonical paragraph + cross-link
from the others**:

| Theme                                     | Restated in                                                                    | Canonical home                              |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| "Everything's a subscriber on the bus"    | event-stream §1, vx-cloud §9, extension-protocol §14, north-star §3.2          | **event-stream §1**; others link            |
| "Content addressing is the only identity" | distributed-ci §4, north-star §3.1, vx-cloud §5 (cross-org), event-stream §4.2 | **north-star §3.1**; others link            |
| "Fail-safe to local, never block"         | distributed-ci §6, vx-cloud §11, extension-protocol §10, north-star §3.3       | **north-star §3.3**; others link            |
| "Shell is the API for tasks"              | extension-protocol §12, north-star §3.4                                        | **north-star §3.4**; CLAUDE.md already pins |
| WireEvent + RunState description          | event-stream §4, extension-protocol §3, vx-cloud §3                            | **event-stream §4** is authoritative        |

Action: in a follow-up PR, replace the duplicated paragraphs with a
one-liner + link to canonical. Net negative LOC across the proposal
set; less drift risk.

---

## 2. Contract sharpening (where boundaries leak today)

### 2.1 distributed-ci `worker:*` messages vs `protocol.ts`

`distributed-ci-2026-06.md §4` introduces `WorkerToCoord` /
`CoordToWorker` types, but does not say how they relate to the
existing `protocol.ts` `Server|ClientMessage` enum. Without
unification we'd end up with two parallel wire enums.

**Resolution.** Make the coordinator wire one **extension** of
`protocol.ts`. Three roles share one envelope; the `t` field is
shared namespace. Worker messages prefix with `worker:`, coordinator
messages with `task:` / `coord:`, today's run delegation stays under
`run:` / `event:` / `result:`. One `valibot` schema, three
role-shaped subtypes selected by an initial `hello` message.

### 2.2 extension-protocol channels vs the bus

extension-protocol §3 introduces `vx:events`, `vx:run`, `vx:rpc`,
`vx:submit` as "channels" but never says how they map to the
transport. Today devframe provides streaming channel + shared state.
After cutting devframe (see §5 below), the mapping needs to be
explicit.

**Resolution.** Channels are **JSON-RPC 2.0 methods + notifications**
over the chosen transport (WS/SSE/NDJSON):

| Channel     | JSON-RPC method                                                | Direction       |
| ----------- | -------------------------------------------------------------- | --------------- |
| `vx:events` | notification `events.append`                                   | server → client |
| `vx:run`    | request/response `state.snapshot` + notification `state.patch` | both            |
| `vx:rpc`    | request/response `<method>`                                    | client → server |
| `vx:submit` | request `submit.run` + stream                                  | client → server |

This means: **one wire**, four logical surfaces. Today's
`WireEvent` becomes the params of `events.append`; today's
`RunState` becomes the result of `state.snapshot`. No new format,
no new framing — JSON-RPC 2.0 IS the framing.

### 2.3 vx-cloud `run_events` blob vs WireEvent JSON

vx-cloud §3 introduces `run_events.event_json TEXT` storing
serialized `WireEvent`s. But `TaskOutcome.wallclockStartNs` is a
bigint, and `JSON.stringify` THROWS on bigints (verified blocker
from event-stream-2026-06.md §4.2). The existing `toWireEvent`
projection already handles this (decimal-string ns).

**Resolution.** The cloud only persists **`WireEvent` (the projected
form)** — never `RunEvent` raw. Document the rule: the boundary
between in-process and any storage/wire form is `toWireEvent`. The
inverse `fromWireEvent` (live in `wire-render.ts`) rebuilds for
consumers. Two-step pipeline: `RunEvent → toWireEvent → JSON →
storage → JSON → wire-render → terminal`.

### 2.4 predictive-execution `HistoryTable` data source

§4 introduces `HistoryTable` but is fuzzy about WHO loads it. For
local runs it's `cache.db`. For cloud-aware runs it's an RPC. The
contract should be **one loader interface with two implementations**:

```ts
type HistoryProvider = {
  loadFor(taskIds: string[]): Promise<HistoryTable>
}
```

- `LocalHistoryProvider` — runs the SQL CTE the deleted TUI
  prototyped.
- `CloudHistoryProvider` — calls `vx:rpc / getTaskHistory` over the
  extension protocol (i.e. an inspector).

`prepareRun` picks the provider based on the same logic that selects
the cache backend (env var or workspace config). The HistoryTable
interface stays.

---

## 3. Bugs / contradictions to fix in the docs

### 3.1 distributed-ci `worker:pull` missing identity

§4 shows `{ t: 'worker:pull'; available: number }`. The coordinator
needs to know which worker is asking. Either the workerId is implicit
from the WS connection (one connection per worker — the realistic
case, fine), or it should be on the message. Document the assumption.

### 3.2 vx-cloud schema assumed PostgreSQL; now D1

The schema in §3 used `INTEGER PRIMARY KEY` and `ROW_NUMBER() OVER
(PARTITION BY ...)`. D1 is SQLite — both are supported, but the
JSONB column (`event_json` was implicitly JSONB-shaped) does NOT
have native JSONB on D1. Resolution: store as TEXT, use SQLite's
JSON1 extension functions for query. (Already shipped in CF D1; no
schema change needed.)

### 3.3 extension-protocol Phase F "default-on" promises a perf gain not yet measured

predictive-execution §11 Phase F says "Default-on for `predictive`.
The improvements are universal enough to make non-opt-in." This is
unfalsifiable today — we have no data. Downgrade to: _"Phase F:
gated on six months of telemetry showing > 5% wall-time improvement
on representative workloads with zero observed regressions; until
then, opt-in via `defineWorkspace({ predictive: true })`."_

---

## 4. Simplifications (collapse parallel concepts)

### 4.1 In-process plugins ≡ WS subscribers — one Plugin contract

extension-protocol §5 introduces `Plugin` for in-process and §3
introduces `subscriber` for over-the-wire. They have **identical
contracts**: receive events, optionally expose RPC methods.

Collapse to **one** `Plugin` interface that ships in two flavors:

```ts
type Plugin = {
  name: string
  setup(ctx: PluginContext): void | Promise<void>
}
// In-process: registered via defineWorkspace({ plugins: [...] })
// WS: a thin shell that proxies the same lifecycle hooks over JSON-RPC
```

The remote-WS Plugin runs as a sandboxed client of `vx serve`; the
in-process Plugin runs in the same Bun process. The lifecycle hooks
(`onRunStart`, `onTaskStart`, …) are identical. Net: one mental
model, less doc.

### 4.2 Coordinator (distributed-ci) ≡ RunCoordinatorDO (vx-cloud)

Same role: per-run state holder + ready-queue + WS fan-out. Different
deployment targets (Bun process for self-hosted; Durable Object for
CF cloud). Document the shared contract as a class interface; ship
two implementations. The Durable Object form gets WebSocket
Hibernation (sleeps between events; no cost); the Bun form gets
process-local state.

### 4.3 Cache layer cluster: lift `Digest` as the explicit key type

Today `CacheLayer` operates on string hashes. Three of the proposals
add storage backends (R2 for cloud, REAPI CAS for hypothetical Bazel
interop, FS for self-hosted). Cleaner shape (from the Bazel research
import):

```ts
type Digest = { hash: string; sizeBytes: number }
type CASBackend = {
  put(digest: Digest, bytes: ReadableStream): Promise<void>
  get(digest: Digest): Promise<ReadableStream | null>
  has(digest: Digest): Promise<boolean>
}
// CacheLayer composes a CASBackend + an entries index (D1 or SQLite)
```

`sizeBytes` IS the truncation check; we lose nothing by carrying
it. The `Cache` becomes `CASBackend(local FS) + entries(SQLite)`;
`RemoteCache` becomes `CASBackend(HTTP)` + remote entries metadata.
Pluggable from day one.

### 4.4 The seven extension-protocol phases collapse to three

The original §11 phasing was: A (SDK) → B (RPC) → C (driver) → D
(in-proc plugin) → E (RPC plugin) → F (Python SDK) → G (MCP).
Seven phases is process theatre. Real shape:

- **Phase 1**: Bus surfaces over JSON-RPC 2.0 (subscriber + inspector +
  driver, one wire). MCP adapter ships with it (free, the JSON-RPC
  envelope IS the MCP envelope).
- **Phase 2**: in-process Plugin API (Vite-style lifecycle hooks)
  via `defineWorkspace({ plugins: [...] })`. Reference impl: the
  terminal renderer becomes the first built-in plugin.
- **Phase 3**: language SDKs (TS + Python). Bonus, not load-bearing.

The original §11 padded out distinct surfaces (inspector/driver/
subscriber/plugin) that all share one bus, one envelope, one
runtime. Three-phase plan is honest.

---

## 5. Third-party adoption decisions (synthesis of both research passes)

### 5.1 Adopt (3)

| Tool                                         | What for                                     | Cost                                                                              |
| -------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| **`@modelcontextprotocol/sdk`**              | `vx mcp` — agents talk to vx as a typed tool | One dep; matches July-2026 stable                                                 |
| **Hono**                                     | `vx serve` HTTP + the CF Workers app         | One dep; ~14KB; Bun-native + Workers-native                                       |
| **OpenTelemetry CI/CD semantic conventions** | Event stream / span shape                    | Vendoring the field-name spec; zero runtime dep until a `@vx/otel-bridge` package |

### 5.2 Inspire (8)

| Idea                          | From                          | Adopt how                                                                     |
| ----------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| **CAS digest model**          | Bazel REAPI                   | Lift `Digest = (hash, sizeBytes)` into cache; see §4.3                        |
| **Hybrid execution / racing** | Buck2                         | Coordinator races local vs remote workers; first-to-respond wins              |
| **JSON-RPC 2.0 envelope**     | MCP + A2A + birpc convergence | Single wire envelope for all four extension channels                          |
| **OTel LogRecord shape**      | OTel logs-replacing-events    | `WireEvent` fields: `time, severityNumber, body, attributes, traceId, spanId` |
| **Vite plugin lifecycle**     | Vite / Rollup                 | `onRunStart / onTaskStart / onTaskComplete / onCacheLookup / onRunEnd`        |
| **BuildBuddy results UI**     | BuildBuddy product            | Reference for `vx insights` flamegraph + per-run page                         |
| **Nix narinfo sidecar**       | Nix store                     | Optional signed metadata next to cache artifacts (multi-tenant trust)         |
| **A2A protocol shape**        | Linux Foundation A2A          | Cloud-side run delegation envelope; future                                    |

### 5.3 Skip (12)

REAPI on the wire (wrong granularity for our resolved-config key);
BuildBarn / NativeLink as backends (REAPI-only); NATS / JetStream
(adds a sidecar process; our scale doesn't need it); Temporal /
Restate (we're seconds-to-minutes, not days); Cap'n Proto /
FlatBuffers / msgpack (JSON+valibot is faster than our event rate
needs); Apache Arrow / Parquet / Postgres in core (SQLite + D1
holds it); WebTransport (no Safari); WebContainers in core docs
(Bun doesn't run in WC); Effect-TS (system-wide commitment;
overkill for 19 deps); Phoenix LiveView / Electric (wrong runtime);
Sentry / PostHog as our backend (build telemetry isn't their
shape); Buildkite / GHA worker protocol (locked to their control
planes).

### 5.4 Plan exit (1)

**devframe.** Useful as a quick first surface; not load-bearing.
Risks identified in the research pass: single-author 0.x, three
rough edges hit in first integration, ~33 packages of closure with
a native TS parser inside. Plan: by 0.6, the bus must work with
**Hono + raw WS** as the default transport, devframe gated behind
an explicit `--devframe` opt-in. One-file removal when the time
comes; the in-process bus is already devframe-agnostic.

---

## 6. The Cloudflare cloud pivot

The original `vx-cloud-2026-06.md` framed the backend as
"PostgreSQL + S3, with Helm + docker-compose for deploy." That's
gone. The new framing (already applied in this review pass): **the
cloud is a Cloudflare Workers project at `apps/cloud/`,
template-spawnable into any user's CF account in ~5 minutes**.

Stack mapping:

| Concern                  | CF primitive        | Why                                                                        |
| ------------------------ | ------------------- | -------------------------------------------------------------------------- |
| Stateless HTTP           | **Workers**         | Edge-distributed, scale-to-zero, free tier covers most teams               |
| Cache artifacts          | **R2**              | S3-compatible API, **zero egress fees** — changes the read:write economics |
| Relational (orgs, runs)  | **D1**              | SQLite at edge; 10GB free per database                                     |
| Per-run state + WS       | **Durable Objects** | Stateful actors; WebSocket Hibernation = no $/idle                         |
| In-flight dedup          | **Durable Objects** | One DO per task hash; content-addressed naturally                          |
| Event ingest buffer      | **Queues**          | Absorb CI run spikes; batch into D1                                        |
| Token + flag cache       | **KV**              | Sub-ms global reads of small hot data                                      |
| External Postgres escape | **Hyperdrive**      | When a team outgrows D1; same code, different binding                      |

**Why this pivot is structurally important**: the friction floor
for "evaluate vx cloud" drops from "provision Postgres + S3 +
container orchestrator + on-call" to `git clone && bun wrangler
deploy`. The OSS-first promise that the original doc made (the
hosted runtime IS the OSS runtime) is even stronger here — there is
no proprietary glue; the SaaS is one CF account deployment of the
same code, no special configuration.

**Implication for distributed-ci**: the coordinator gains a third
deployment target — running INSIDE a Durable Object on the user's
own CF account. For "trigger a distributed CI run from any
provider," that's a free coordinator with global reach and no
infrastructure. The existing in-process and `vx serve` coordinator
forms stay.

**Risk surfaced**: Workers' 30s CPU-time per request cap. Irrelevant
for any single request we make (cache GET/PUT, event ingest, RPC
calls all complete in ms), but **a long-running coordinator must
live in a Durable Object**, not a plain Worker handler. The
architecture handles this; document it.

---

## 7. The wire-format consolidation (most leverage in the smallest PR)

The current state has THREE event shapes in flight:

1. `RunEvent` (in-process, has bigints)
2. `WireEvent` (post-projection, JSON-safe)
3. `ServerMessage|ClientMessage` (`protocol.ts` envelope for `vx serve`)

Plus future surfaces want: 4. MCP tool result framing (JSON-RPC 2.0) 5. A2A inter-agent envelopes (JSON-RPC 2.0) 6. OTel exporter output (OTLP) 7. devframe channels (currently in vx)

That's 7 framings. Consolidate to **two** (in-process `RunEvent` for
type fidelity, wire JSON-RPC 2.0 with `WireEvent` as the param
payload). Map every transport to the JSON-RPC envelope:

- **WS**: `{"jsonrpc":"2.0","method":"events.append","params":{event}}` per frame.
- **SSE**: `event: events.append\ndata: {...}` per message.
- **NDJSON**: one JSON-RPC envelope per line.
- **MCP**: already JSON-RPC 2.0 — direct passthrough.
- **A2A**: already JSON-RPC 2.0 — direct passthrough.
- **OTLP**: one-way adapter in `@vx/otel-bridge` that turns
  `events.append` into LogRecord; never in core.

The payload of `events.append` matches OTel LogRecord shape (per
the research pass — `time, severityNumber, body, attributes,
traceId, spanId`). We get OTel-shape and MCP/A2A interop in one
move.

**Concrete next step (own design doc)**: write
`docs/design/wire-protocol-2026-06.md` codifying this — one short
doc that pins (a) the JSON-RPC envelope, (b) the LogRecord-shaped
payload, (c) the four channel methods, (d) the three transports.
Then everything else follows mechanically.

---

## 8. Feasibility audit (per-proposal verdict)

### 8.1 distributed-ci — feasible; CI integration is the risk

The protocol extension is straightforward (1-2 weeks). The risk is
the **CI integration story** (§7.1 GHA composite). Cross-runner
networking on GHA-hosted runners requires either Tailscale (free
tier, well-known), ngrok/cloudflared (works), or self-hosted
runners (best). The composite action needs to handle the tunnel
setup elegantly. Plan: ship Phase A-B (in-process + multi-worker)
WITHOUT the GHA composite first; ship the composite once we know
which tunnel solution survives a year of GHA changes.

### 8.2 vx-cloud — feasible AFTER the CF pivot; risk dropped substantially

Pre-pivot the risk was real (we'd be building a distributed system
with Postgres + auth + multi-tenancy + Helm). Post-pivot, the
moving parts are: a few Workers, one D1 schema, one R2 bucket
prefix scheme, two Durable Object classes. Estimated impl size:
1500-2500 LOC over 3-4 weeks for Phases A-C. Risk shifted from
"can we operate this?" to "is CF the right pick?" — and the
**template-spawnable angle inverts the question**: users operate
their own; we operate the SaaS as one instance among many.

### 8.3 extension-protocol — feasible; Phase 1 is the only commit

Post-consolidation (§4.4), Phase 1 ships subscriber + inspector +
driver + MCP all at once on the unified JSON-RPC 2.0 envelope.
Estimated impl size: 600-1000 LOC (mostly transport adapters; the
bus already exists). Phase 2 (plugin API) is a `defineWorkspace`
extension. Phase 3 (SDKs) is a community contribution opportunity.

### 8.4 predictive-execution — feasible; data dependency is the gate

HistoryTable revival is ~200 LOC of SQL + a memoizing loader. The
scheduler integration is ~100 LOC of priority override. Bandit
retry is ~150 LOC. Regression detection is ~250 LOC. **Total ~800
LOC across the whole proposal** — the smallest of the five. The
gate is real-world data: we need 4-8 weeks of observed runs before
we can show a wall-time improvement.

### 8.5 architecture-north-star — feasible as synthesis

The six-layer spine holds. With the CF pivot and the wire-format
consolidation applied, the layer boundaries get sharper: layer 5
(event substrate) is now formally JSON-RPC 2.0; layer 6 (surfaces)
all consume the same envelope; the cache layer cluster gets a
clean `Digest` + `CASBackend` shape.

---

## 9. Revised wave plan (replaces north-star §5)

Reordered to reflect (a) the CF pivot collapses cloud-Phase-C-D
work and (b) the wire-format consolidation unblocks four downstream
surfaces in one PR.

### Wave 1 — Already shipped

- RunBackend + serviceBackend, event bus + busLogger + RunState
  reducer, remote prefetch + in-flight dedup, `vx serve` + `vx dev`
  hub, distributed cache (Turbo-wire-compatible + HMAC).

### Wave 2 — Next 4 weeks (small PRs, high leverage)

- **`docs/design/wire-protocol-2026-06.md`** — codify JSON-RPC 2.0
  envelope + OTel LogRecord payload shape (1-day doc).
- **`Digest` + `CASBackend` refactor** in `src/cache/` (~200 LOC,
  byte-identical behaviour). Unblocks R2 backend later.
- **HistoryTable revival** behind a `vx info --history` flag for
  early validation. SQL CTE is already prototyped.
- **Hono migration** of `vx serve` HTTP routes (replaces direct
  `Bun.serve` handlers — better SSE/WS ergonomics + readiness for
  the CF target).

### Wave 3 — Weeks 5-8

- **`vx insights serve`** — local SPA over `cache.db` (Solid +
  UnoCSS + DuckDB-WASM for client-side analytics). Replaces the
  cloud-Phase-A surface; ships standalone.
- **`vx mcp`** — JSON-RPC 2.0 / MCP server exposing
  `runTasks / getRunState / explainCacheKey / whyDidThisRerun`.
- **Predictive Phase B** — history-aware critical-path priority in
  the scheduler, opt-in via `defineWorkspace({ predictive: true })`.

### Wave 4 — Weeks 9-16

- **`apps/cloud/` scaffold** — Wrangler-managed Workers project
  with D1 + R2 + DOs + Queue + KV bindings. Reference deploy via
  README; documented as the template.
- **Distributed CI Phase A-B** — coordinator + multi-worker with
  the JSON-RPC envelope (no GHA composite yet).
- **Plugin API** — Vite-style lifecycle hooks on
  `defineWorkspace.plugins`; terminal renderer migrated as the
  first built-in plugin.

### Wave 5 — Weeks 17-26

- **vx cloud template promotion** — published to `cloudflare/
templates` registry; `npx create-cloudflare vx-cloud` works.
- **Distributed CI Phase C-D** — GHA composite + capability labels
  - critical-path priority.
- **`@vx/otel-bridge`** package — one-way exporter for the OTel CI/CD
  conventions.

### Wave 6 — Long arc (no commitments yet)

- Hosted SaaS at `cloud.vx.dev` (one CF account deployment of the
  template). Trial + paid tiers.
- Signed manifests + sparse-clone workers (distributed-ci §9 trust
  model).
- A2A inter-agent envelopes for cloud-side delegation.

---

## 10. Five carved-in-stone rules (revised)

Replaces north-star §3 with rules that now reflect the imports +
consolidations:

1. **Content addressing is the only identity.** Every task has a
   `(hash, sizeBytes)` Digest. Storage backends are pluggable; the
   key is constant.
2. **One envelope, many transports.** JSON-RPC 2.0 frames every
   wire message. Transports (WS / SSE / NDJSON / MCP / A2A /
   OTLP-bridge) are encoded outside the envelope.
3. **The event stream is the protocol.** OTel-LogRecord-shaped
   payloads; the bus is fire-and-forget; consumers handle
   backpressure on the consumer side.
4. **Fail-safe to local.** Every external dependency (remote
   cache, coordinator, cloud uploader, plugin) degrades to a
   local-only run. The local path is THE path.
5. **Shell is the API for tasks.** Plugins observe and submit;
   they never redefine what executing a task means.

(Rule 5 from the old §3 — "validate at boundaries, trust the
inside" — folds into rule 2: the JSON-RPC envelope IS the boundary,
validated once at deserialization.)

---

## 11. What this review IS NOT

- Not a green-light to start every Wave 2 item at once. Pick one
  (the wire-protocol doc — it unblocks four downstream surfaces).
- Not a commitment to ship every proposal in the five docs. The
  vision frame stands; the implementation order is now realistic.
- Not a rewrite of the proposals. Section-level edits to vx-cloud
  (CF pivot) have already landed in this PR; the others get edits
  in a follow-up keyed to (a) the wire-protocol doc, (b) the
  HistoryTable provider interface, (c) the Plugin contract
  collapse.

The review's deliverable is **this doc + the CF pivot edit to
vx-cloud**. Everything else is incremental, owner-scheduled.
