# vx Cloud — hosted observability, cache, and execution

Status: proposal (2026-06-20). Owner ask: "hosted service where people
could see local and company-wide things." Pairs with
`distributed-ci-2026-06.md` (the execution protocol) and
`remote-cache.md` (the existing cache transport). This is the
_observability + multi-tenancy_ layer on top.

## 1. The pitch in one paragraph

vx Cloud is a hosted (and **self-hostable**) service where every `vx
run` — local on a laptop, on CI, on a worker farm — streams its event
log into a long-lived database. A web UI rendered on top exposes:
**team-wide flamegraphs**, **regression detection** ("test X went from
2s to 30s last Tuesday across 40 PRs"), **cache hit-rate per project
per branch**, **slowest tasks rolled up by author**, **per-PR
comparison** ("this branch is 2.3× slower than main, here's why"). It
**also** hosts a shared remote cache + a shared coordinator (so a
team's CI runs without provisioning anything). One product, one wire
protocol, three faces: local insights, team analytics, hosted
execution.

The economic story: the **OSS** core ships everything self-hostable.
Hosted is convenience. Companies who want it managed pay for that;
companies who want their data on their own boxes run the same code on
their own boxes. We do not gate features behind hosted-only.

## 2. The three faces

### 2.1 Local face — `vx insights`

Today: every `vx run` writes a `runs` row to `cache.db` with task
spans, cache hits, durations. The `vx info` doctor reads aggregates;
that's the only consumer.

Tomorrow: `vx insights serve` opens a localhost web UI that reads
`cache.db` directly (no daemon, no upload). The same SPA the hosted
product serves, pointed at a local SQLite. A developer can answer:

- "Why was that last run slow? Show me the spans."
- "What's my hit rate on this branch?"
- "What's eaten the most CPU this week?"
- "Show me a flamegraph of run `<id>`."

This is what `apps/dashboard` aimed for and got removed. The reason
this revival works: **we already have the data** (runs table, spans,
cpu/rss, cache provenance — all v11+ columns). The UI is purely
historical-read; no live coupling to the orchestrator that killed the
previous attempt. And the `RunState` reducer + `WireEvent` stream from
`event-stream-2026-06.md` already give us a fully-typed live view to
_also_ render on the same UI for in-flight runs.

### 2.2 Team face — `vx insights upload`

A team running self-hosted: every CI run posts its event log + `runs`
row to a shared backend (`https://vx-insights.acme.corp` or
`https://cloud.vx.dev`). Same shape as the local UI, but the data is
aggregated across every contributor's machine, every PR, every CI
job. The data model is **append-only** — runs are immutable facts.
The UI does analytics on top.

The web UI gains team-only views:

- **Per-project trends** — was this project's `test` task always 12s,
  or did it creep up?
- **Per-author breakdown** — who's writing tasks that miss the cache
  most often?
- **PR diff view** — this PR's runs vs main's recent runs.
- **Bottleneck atlas** — the company's longest critical paths,
  ranked.
- **Cache cliff** — sudden drops in hit rate (often signal an
  unintended input drift; we can root-cause).

### 2.3 Hosted face — `vx cloud`

Optional, paid (for the hosted SaaS) or self-deploy (Helm chart,
docker-compose, single-binary). Combines insights + remote cache +
distributed-execution coordinator + signed-manifest authority + CI
integration. Drop-in replacement for Nx Cloud, with these structural
differences:

- **Turbo-wire-compatible remote cache.** A team that hasn't migrated
  off Turbo can still benefit — point Turbo at us, then migrate to
  vx incrementally.
- **OSS reference implementation.** The hosted runtime IS the OSS
  reference impl. No "community edition" with crippled features.
- **No proprietary protocol.** Wire is documented; you can write
  your own coordinator and we'll route to it.

## 3. Data model

The atomic unit is a **Run**. Already exists in `cache.db.runs`. We
extend it with team-aware shape:

```sql
-- Existing (extended)
runs (
  run_id            TEXT PRIMARY KEY,         -- UUIDv7
  org_id            TEXT,                     -- NEW; null on local
  repo              TEXT,                     -- NEW; git remote URL
  branch            TEXT,                     -- NEW; HEAD ref
  commit_sha        TEXT,                     -- NEW; HEAD commit
  pr_number         INTEGER,                  -- NEW; if applicable
  triggered_by      TEXT,                     -- NEW; user/ci-bot
  ci_provider       TEXT,                     -- NEW; gh/gl/buildkite
  started_at        INTEGER,
  ended_at          INTEGER,
  exit_code         INTEGER,
  cpu_ms            INTEGER,
  peak_rss_bytes    INTEGER,
  wallclock_start_ns INTEGER,
  wallclock_end_ns   INTEGER,
  ...
)

-- New
run_tasks (
  run_id            TEXT,
  task_id           TEXT,                     -- project#task
  task_hash         TEXT,                     -- the v22 input key
  status            TEXT,                     -- success/failed/skipped/aborted
  cache_source      TEXT,                     -- miss/fresh/local/remote
  duration_ms       INTEGER,
  cpu_ms            INTEGER,
  peak_rss_bytes    INTEGER,
  span_start_ns     INTEGER,
  span_end_ns       INTEGER,
  worker_id         TEXT,                     -- for DTE
  stdout_artifact   TEXT,                     -- pointer to log blob (S3/local)
  stderr_artifact   TEXT,
  PRIMARY KEY (run_id, task_id)
)

run_events (
  run_id            TEXT,
  seq               INTEGER,                  -- monotonic per run
  ts_ns             INTEGER,                  -- relative to run start
  event_json        TEXT,                     -- the serialized WireEvent
  PRIMARY KEY (run_id, seq)
)
```

`run_events` is the **full event log** — exactly the WireEvents the
orchestrator emits today. Replaying them rebuilds the timeline
exactly: the same data that drives a live UI drives a historical one.
This is _the_ design unification: **one event stream, two consumers
(live + history)**.

The hosted variant pages event blobs out to S3-compatible storage
when individual events grow large (long stdout dumps). The pointer
plus a content hash stays in SQLite (or PostgreSQL for the hosted
multi-tenant case).

## 4. Architecture

**The cloud is Cloudflare-native.** Edge compute (Workers) + edge
SQLite (D1) + S3-compatible object storage (R2) + stateful actor
runtimes (Durable Objects) + queues (Queues). Self-hostable by
**deploying the template into your own Cloudflare account** — `npx
wrangler deploy` from the cloned repo, done in five minutes. No
PostgreSQL, no S3 contract, no container orchestrator, no on-call.

This choice is deliberate. The combination of (a) global edge
distribution, (b) generous free tier (10M Worker requests/month, 10GB
R2/month, 5GB D1/month free), (c) zero-egress R2, and (d) Wrangler's
one-command deploy collapses "spin up a vx cloud for your team" from
a Kubernetes adventure into a script. Anyone can fork the template
and have a private hosted backend running before lunch.

```
┌──────────────────── Cloudflare account (yours or hosted) ────────────────────┐
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Workers (edge compute)                                              │    │
│  │  • /v8/artifacts/*    — Turbo-wire cache (PUT/GET/HEAD)             │    │
│  │  • /v1/events/ingest  — batched WireEvent uploader                   │    │
│  │  • /v1/runs/* etc.    — Insights API                                 │    │
│  │  • /v1/coord/*        — distributed-execution submission             │    │
│  │  • /v1/ws             — WS upgrade to the per-run Durable Object     │    │
│  │  • Static asset binding — serves the SPA built from /apps/insights   │    │
│  └─────────────┬─────────────────────────┬─────────────────────┬───────┘    │
│                │                         │                     │            │
│                ▼                         ▼                     ▼            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐  │
│  │  R2 (objects)    │    │  D1 (SQLite/edge)│    │ Durable Objects      │  │
│  │  • <hash>.tar.zst│    │  • runs          │    │ • RunCoordinatorDO   │  │
│  │  • event blobs   │    │  • run_tasks     │    │   (1 per active run; │  │
│  │  • per-org prefix│    │  • orgs/members  │    │    holds graph state,│  │
│  │  • presigned PUT │    │  • api_tokens    │    │    fans WS to subs)  │  │
│  │  • zero egress   │    │  • global indexes│    │ • InflightDedupDO    │  │
│  └──────────────────┘    └──────────────────┘    │   (per-hash; the     │  │
│                                                  │    join-not-rerun    │  │
│  ┌──────────────────┐    ┌──────────────────┐    │    pattern from      │  │
│  │  Queues          │    │  KV              │    │    execution-service)│  │
│  │  • event ingest  │    │  • org-token     │    └──────────────────────┘  │
│  │    buffering     │    │    lookup cache  │                              │
│  │  • aggregation   │    │  • feature flags │                              │
│  └──────────────────┘    └──────────────────┘                              │
└──────────────────────────────────────────────────────────────────────────────┘
    ▲              ▲              ▲                    ▲
    │ PUT/GET tar  │ POST events  │ WS task RPCs       │ OAuth
    │              │              │                    │
┌───┴────┐    ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
│ vx run │    │ vx run  │    │ vx run  │    │ Browser │
│ (local)│    │  (CI)   │    │ --worker│    │  user   │
└────────┘    └─────────┘    └─────────┘    └─────────┘
```

**Why each piece.**

- **Workers** for stateless HTTP. They scale to zero, run at the
  edge close to users, no provisioning. Free tier covers most teams
  forever. The Workers runtime is V8-isolate-based — fast cold
  starts (~5ms), but watch out for the 30s CPU-time cap per request
  (irrelevant for our request shape; nothing we do takes that long).

- **R2** for the cache artifacts and the larger event blobs.
  S3-API-compatible, **zero egress fees** (unique to R2 — this
  changes the cost model for a cache that's read 100× more than
  it's written). Presigned URLs for the actual byte transfer so
  Workers don't proxy bytes.

- **D1** for the relational store. SQLite on the edge, read-replicated
  globally, 10GB free per database. Our schema is small (rows per
  task, not per file). Wrangler-managed migrations. For accounts
  that outgrow D1's 10GB cap, **Hyperdrive** bridges to an external
  Postgres — same Workers code, different binding.

- **Durable Objects** for stateful per-run coordination. The single
  most important piece: a `RunCoordinatorDO` is a per-run singleton
  with strong consistency, holds the graph + ready queue + worker
  registrations + WS connections. Solves the "where does the live
  state live" problem that would otherwise require Redis. Pairs
  natively with WebSocket Hibernation (DO sleeps between events;
  no $/idle-connection). The `InflightDedupDO` is the
  content-addressed dedup pattern from
  `execution-service-2026-06.md` materialized as a global edge
  service — one DO per task hash, holds the in-flight promise so a
  second submitter joins instead of re-running.

- **Queues** to buffer event-ingestion spikes. A noisy CI run sends
  500 events/second; the queue absorbs and the consumer Worker
  batches into D1/R2. Backpressure-friendly, retry on failure.

- **KV** for low-latency global reads of small hot data — token →
  org lookup, public-key cache for HMAC verification, per-org
  feature flags. Eventually consistent but cheap.

The whole stack is **one repo, one `wrangler.toml`, one
`bun wrangler deploy` command** to bring up.

## 5. Identity, authz, multi-tenancy

The honest tradeoffs:

- **Identity**: GitHub OAuth (via Workers OAuth helper, ~50 LOC) +
  a generic OIDC fallback. No proprietary user database; you bring
  your own SSO. Sessions live in **D1**; auth state per-request
  validated against a **KV**-cached lookup (sub-ms p99).
- **API tokens**: scoped to (org, role, expiry), stored hashed in
  D1, lookup-cached in KV. Used by CI and by the worker
  registration handshake. Token revocation purges the KV entry
  immediately.
- **Per-org isolation**: every D1 row carries `org_id`; every query
  filtered through a tiny middleware that injects the auth context.
  R2 objects use a per-org key prefix (`<org_id>/<hash>.tar.zst`)
  so a misconfigured presigned URL cannot leak cross-org.
- **No cross-org leakage**: a hash collision across orgs returns
  miss for the org that doesn't own it. Hashes are not assumed
  globally unique; the `(org_id, hash)` tuple is the cache key
  enforced at the Worker layer.

The cache wire stays Turbo-compatible — the team ID + token model
maps straight onto our (org_id, api_token) tuple. Existing Turbo
clients work pointing at us.

## 6. The DX flow we want users to feel

```bash
# Day 1: local insights
$ vx run lint test
✓ done in 2.3s

$ vx insights
→ http://localhost:5173 (your local runs, all-time)

# Day 7: connect to a team
$ vx insights link --org acme
→ opens browser, OAuth, done.
$ vx run lint test
✓ done in 2.3s
→ uploaded to acme/insights

# Day 14: turn on the team cache
$ cat .env
VX_REMOTE_CACHE_URL=https://cloud.vx.dev/v8/artifacts
VX_REMOTE_CACHE_TOKEN=team_xxx

# Day 21: distributed CI
$ cat .github/workflows/ci.yml
- uses: vznjs/vx-distributed-action@v1
  with:
    tasks: lint test build
    cloud: ${{ secrets.VX_CLOUD_TOKEN }}
```

Each step is opt-in. Nothing breaks if you stop using vx Cloud — you
fall back to the local data path.

## 7. Privacy & data minimization

What we DO NOT collect:

- **Stdout/stderr contents by default.** Logs stay local unless the
  user opts in (per-org policy). The hosted UI can show "logs not
  uploaded" rather than the bytes.
- **Source code.** We never ship source. The cache stores _outputs_,
  which the user has explicitly declared.
- **Telemetry beyond the user's runs.** No hidden pings.

What we DO collect:

- The run metadata: durations, statuses, hashes, cache
  provenance. This is what powers the analytics. It's the same data
  Nx Cloud + Turbo collect for paying customers.
- Optionally: stdout/stderr for failed tasks (defaulted off, can be
  toggled per-org for debugging).

Hosted is the only place this matters; self-hosted means it stays on
your boxes regardless. The OSS surface treats local SQLite as the
canonical store.

## 8. The OSS reference implementation — `apps/cloud/`

The cloud lives in this repo as `apps/cloud/`, a Cloudflare Workers
project. The same code runs the hosted SaaS at `cloud.vx.dev`. The
**README is the deploy guide**:

```bash
$ git clone https://github.com/vznjs/vx
$ cd vx/apps/cloud
$ bun install
$ bun wrangler login          # one-time auth to your CF account
$ bun wrangler d1 create vx_cloud
$ bun wrangler r2 bucket create vx-cloud-artifacts
$ bun wrangler deploy
→ Deployed to https://vx-cloud-<your-subdomain>.workers.dev
```

That's five minutes to a private hosted vx for your team. The
`wrangler.toml` defines every binding (D1, R2, DOs, Queue, KV) so a
fresh clone is provisionable verbatim. Migrations live as `.sql`
files under `apps/cloud/migrations/` and apply via
`wrangler d1 migrations apply`.

**Template-spawnable.** We publish the same source as a `cloudflare/
templates`-registered template so users can `npx create-cloudflare
vx-cloud` and skip the clone-and-configure dance entirely — the
template wizard prompts for the bucket/D1 names and writes
`wrangler.toml` for you. The result is **a hosted vx that the user
owns, in their CF account, with their billing**, deployed by typing
~3 commands.

This is the structural answer to "open vs. proprietary": there is no
proprietary component. The hosted runtime is the OSS runtime, the
hosted SaaS is just one deployed instance. If `cloud.vx.dev` goes
away tomorrow, every customer can spin their own up in an afternoon.

### 8.1 Why not a portable backend?

We considered Postgres + S3 + a generic container deployment (Helm,
docker-compose). **The user-experience math doesn't work.** A team
trying to evaluate vx Cloud should not need to provision a database,
an object store, and a container orchestrator. Cloudflare is the
_only_ stack where the entire surface (compute + relational store +
object store + actor runtime + queue) is one provider, one CLI, one
account, with a free tier that covers small teams forever.

For users who DO want to bring their own storage (Postgres, S3, a
container farm), the **execution-service-2026-06.md** path stays
open — `vx serve` runs anywhere a Bun process runs, and a future
`vx serve --backend postgres` adapter would let it persist. We
ship the CF target first because it removes friction; the
generic-backend target is a follow-up driven by a real ask.

### 8.2 Hyperdrive escape hatch

D1's 10GB-per-database cap is generous but finite. When a team
outgrows it, the **Hyperdrive** binding lets the same Workers code
talk to an external Postgres (RDS, Neon, Supabase) with edge-cached
connection pooling. Migration is one `wrangler.toml` change + a SQL
dump/restore; no code change. So the CF-native default is not a
dead-end.

## 9. The big architectural payoff: one event stream feeds everything

```
┌──── orchestrator (in vx run) ────┐
│   emits WireEvents             →   ──┐
└────────────────────────────────────┘ │
                                       ├──→  terminal renderer (today)
                                       ├──→  --ui local dev server
                                       ├──→  --tui (future)
                                       ├──→  MCP server for agents
                                       ├──→  Insights uploader (this proposal)
                                       └──→  In-process subscribers (plugins, devframe)
```

`devframe-surface.ts` already exposes the stream. The Insights
uploader is _just another subscriber_ — a batched HTTP-POST sink
that flushes events to the cloud API. No new abstraction; one more
adapter on the substrate `event-stream-2026-06.md` built.

## 10. Phasing

| Phase | Ships                                                                                                                     | Validates                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **A** | `vx insights serve` — local SPA over local `cache.db`. Run history, flamegraph, per-task trends. No upload, no cloud.     | The UI is real and useful before any infra exists.                 |
| **B** | The data model extension (`org_id`, `run_tasks`, `run_events`). Migration of `cache.db` schema. Run-event sink interface. | Persisted state survives schema changes; can be replayed/exported. |
| **C** | `vx cloud serve` — single-binary self-hosted backend. Postgres + S3, no auth (token-only). Reference impl ships first.    | Self-hostable from day one. The OSS-first promise.                 |
| **D** | OAuth + multi-tenant + RBAC. Production-grade self-hosted.                                                                | Real teams deploy it.                                              |
| **E** | Hosted SaaS at `cloud.vx.dev`. Trial tier + paid tiers. Same binary, managed.                                             | The commercial path. Funds development.                            |

## 11. Non-goals

- **A proprietary "smart" feature set behind hosted.** Everything
  works self-hosted.
- **Replacing GitHub.** We don't host code/PRs/issues. We're a build
  observability layer.
- **A general-purpose analytics warehouse.** This is a build-runner
  data model. It is not a substitute for Snowflake/BigQuery.

## 12. Performance bar

- Insights API: p99 query latency < 200ms for "last 100 runs of
  project X" or "trend of task T over 30 days." Achieved via
  pre-aggregation rollups (hourly/daily) in PostgreSQL.
- Event ingestion: 10k events/sec/instance, single-postgres backend.
  Batched POSTs from the client (1-second flush window or 64KB
  batches) keep request rates sane.
- Cache hit latency: ≤ 50ms p99 for a remote GET (already the bar
  the existing remote-cache hits). Pre-signed S3 URLs for the actual
  byte transfer keep the metadata service light.

## 13. Open questions

- **Real-time over the hosted backend.** A user might want to watch
  a CI run live from the cloud UI. Solution: the coordinator already
  streams `WireEvents`; the cloud UI can subscribe via SSE/WS the
  same way the local UI does. Defer until we have customers asking.
- **Log retention.** Bounded by org policy. Default: 30 days for
  hosted, infinite for self-hosted. Compaction job ages out
  `run_events` blobs to summary form.
- **Cost model for hosted.** Per-seat? Per-task? Per-cache-GB? The
  Nx Cloud pricing model is per-seat; the Turbo Vercel model is
  per-cache-bandwidth. We'll iterate; the architecture supports
  either.

## 14. The big claim

If we ship this, vx becomes the **only OSS task runner with an
end-to-end story for: local DX → team observability → hosted
execution → CI distribution → cache.** Turbo has cache + (proprietary)
analytics. Nx has cache + (proprietary) DTE + (proprietary) analytics.
vx has cache + DTE + analytics + execution-as-a-service, OSS,
self-hostable, with optional hosted convenience. That's the moat.
