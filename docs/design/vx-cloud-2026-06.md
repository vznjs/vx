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

```
┌─────────────────────────────────────────────────────────────────┐
│                          vx cloud                                │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  Insights  │  │   Cache    │  │ Coordinator│  │   Auth +   │ │
│  │    API     │  │  (Turbo-   │  │  (DTE per  │  │   Org      │ │
│  │ + Web SPA  │  │   wire)    │  │  build)    │  │  identity  │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        │ event log     │ artifacts     │ task graph    │        │
│        ▼               ▼               ▼               │        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Storage (PostgreSQL + S3-compat object store)            │  │
│  │  • runs, run_tasks, run_events                            │  │
│  │  • org, project, member, role                             │  │
│  │  • cache artifacts (per-org bucket)                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        ▲                ▲                ▲                ▲
        │ POST events    │ PUT/GET tar    │ WS task RPCs   │ OIDC
        │                │                │                │
   ┌────┴────┐      ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
   │  vx run │      │  vx run │      │ vx run  │      │ Browser │
   │ (local) │      │  (CI)   │      │ --worker│      │  user   │
   └─────────┘      └─────────┘      └─────────┘      └─────────┘
```

Three services behind one frontend, all stateless except the
storage. Each can scale horizontally; PostgreSQL + S3 are the only
stateful tier.

## 5. Identity, authz, multi-tenancy

The honest tradeoffs:

- **Identity**: GitHub OAuth + a generic OIDC fallback. No
  proprietary user database; you bring your own SSO.
- **API tokens**: scoped to (org, role, expiry). Used by CI and by
  the worker registration handshake.
- **Per-org isolation**: every storage row carries `org_id`; every
  query is `org_id`-scoped. Row-level security in PostgreSQL.
  S3 buckets per-org (or per-org prefix in shared bucket).
- **No cross-org leakage**: a hash collision across orgs returns
  miss for the org that doesn't own it. Hashes are not assumed
  globally unique; the (org_id, hash) tuple is the key.

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

## 8. The OSS reference implementation

We ship `packages/vx-cloud-server` (Bun) — the same code that runs the
hosted service. Single-binary deploy:

```bash
$ vx cloud serve --postgres postgres://... --s3 s3://...
→ vx cloud listening on :8080
```

Helm chart and docker-compose for the common deploy patterns. The
hosted SaaS at `cloud.vx.dev` runs this exact binary, version-tagged.
Customers who outgrow the SaaS migrate by `pg_dump` → `pg_restore`;
their data is theirs.

This is the structural answer to "open vs. proprietary": there is no
proprietary component. The hosted runtime is the OSS runtime.

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
