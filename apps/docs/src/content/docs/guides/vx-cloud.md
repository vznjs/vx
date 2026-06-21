---
title: vx Cloud — Cloudflare-template deployment
description: Spin up a private vx Cloud in your Cloudflare account in 5 minutes. Workers + R2 + D1 + Durable Objects + Queues + KV. HMAC artifact signing, queue→D1 event ingest, OAuth coming.
---

`apps/cloud/` in the vx repo is a Cloudflare Workers project that
ships **template-spawnable hosted observability + cache + execution**.
`bun wrangler deploy` from a fresh clone of the repo gives you a
private vx Cloud running in your own Cloudflare account in about five
minutes. No proprietary glue; the OSS binary IS the hosted runtime.

This guide walks through the deploy. Full design:
`docs/design/vx-cloud-2026-06.md`.

## What you get

A Cloudflare Workers project with these bindings, all declared in
`apps/cloud/wrangler.toml`:

| Binding | Purpose |
| --- | --- |
| **Workers** | Edge HTTP for cache + insights API + Turbo-wire endpoint |
| **R2** (`ARTIFACTS`) | Cache artifact storage (S3-API-compatible, **zero egress fees**) |
| **D1** (`DB`) | SQLite at the edge — orgs, members, tokens, runs, run_tasks, run_events |
| **Durable Objects** (`RUN_COORDINATOR`, `INFLIGHT_DEDUP`) | Stateful actors for per-run coordination + content-addressed dedup |
| **Queues** (`EVENT_INGEST`) | Buffered event ingest from CI runs into D1 |
| **KV** (`TOKEN_CACHE`) | Sub-ms hot lookups for bearer tokens |

## Deploy

Prerequisites: Cloudflare account, `bun` ≥ 1.3.

```sh
git clone https://github.com/vznjs/vx
cd vx/apps/cloud
bun install
bun wrangler login                       # one-time auth
bun wrangler d1 create vx_cloud
bun wrangler r2 bucket create vx-cloud-artifacts
bun wrangler kv namespace create TOKEN_CACHE
bun wrangler queues create vx-event-ingest
bun wrangler d1 migrations apply vx_cloud
bun wrangler deploy
```

Each `create` command prints an ID — paste it into the matching
`TODO: replace with id from wrangler create` line in
`wrangler.toml`. Then `bun wrangler deploy` ships the worker; the
output URL is your vx Cloud origin.

## Point your runner at it

Once deployed, set two env vars in your CI:

```sh
export VX_REMOTE_CACHE_URL=https://vx-cloud-<your-subdomain>.workers.dev/v8/artifacts
export VX_REMOTE_CACHE_TOKEN=<a bearer token from your D1 api_tokens table>
```

`vx run` now reads/writes the remote cache via the standard
Turbo-wire endpoint (which is what `apps/cloud/` exposes).

## HMAC artifact signing

Set `VX_REMOTE_CACHE_SIGNATURE_KEY` on **both** the client and the
Worker:

```sh
# Client (CI machine running vx run)
export VX_REMOTE_CACHE_SIGNATURE_KEY=<shared secret>

# Worker (set via wrangler)
bun wrangler secret put VX_REMOTE_CACHE_SIGNATURE_KEY
```

When set, every cache PUT carries a `x-artifact-tag` HMAC-SHA256
header over `(hash || teamId || body)`. The Worker rejects unsigned
or tampered artifacts with 401/500; the client treats those as
cache miss and re-runs the task. Same scheme Turbo uses; the wire is
compatible.

Tag scheme: `base64(HMAC-SHA256(secret, hash || teamId || body))`.

## Event ingest pipeline

```
   vx run (locally / CI)
        │ POST /v1/events/ingest
        ▼
   ┌──────────────┐   batch    ┌────────────┐  consume   ┌────────┐
   │ Worker route │ ─────────▶ │ Queue      │ ─────────▶ │ Worker │
   │              │            │ EVENT_INGEST│            │ queue()│
   └──────────────┘            └────────────┘            └────┬───┘
                                                              │
                                              groups by runId │
                                              ensures runs row│
                                              allocates seq   │
                                              D1.batch INSERT │
                                                              ▼
                                                         ┌──────┐
                                                         │  D1  │
                                                         │ runs │
                                                         │ run_ │
                                                         │ events│
                                                         └──────┘
```

The consumer (`apps/cloud/src/index.ts` `queue()`) groups messages
by `runId`, ensures the parent `runs` row exists via `ON CONFLICT DO
NOTHING`, allocates `seq` once per run by SELECT MAX + offsets, and
batches inserts atomically via D1's `batch()` API.

## RunCoordinatorDO

One Durable Object per active run, addressed by `runId`. WebSocket
Hibernation pattern: the DO sleeps between events; cost is per
event, not per idle connection. Methods over the JSON-RPC envelope:

- `submit.run` → persists `RunMeta` (runId, orgId, startedAt,
  status='running') and accepts the run.
- `events.append` → broadcasts to subscribed WS clients +
  durably persists via the queue.
- `state.snapshot` → returns the latest `RunMeta`.
- `run.end` → transitions `status='ended'`.

## What's deferred

The hard things; the doc tracks them:

- **GitHub OAuth + multi-tenant org provisioning.** Today auth is
  bearer-token only; tokens are inserted manually into the `api_tokens`
  D1 table.
- **RBAC** beyond the column existing.
- **Per-task InflightDedupDO fan-out.** The DO class is shipped;
  RunCoordinatorDO doesn't address by task hash yet.
- **Hosted SaaS at `cloud.vx.dev`.** When you can spin up your own,
  the SaaS is just convenience.
- **Hyperdrive escape hatch.** Designed for when D1's 10GB cap is
  tight; not wired into `wrangler.toml` by default.

## Costs

Cloudflare free tier covers small teams forever:

- Workers: 100k requests/day
- R2: 10 GB storage, **zero egress**
- D1: 5 GB/database, 100k reads/day
- DOs: 1M requests/month
- KV: 100k reads/day, 1k writes/day
- Queues: 1M operations/month

At workload sizes where these limits bite, Hyperdrive into your own
Postgres is the escape hatch.

## OSS-first guarantees

There is no proprietary component in this stack. Every Worker,
every DO, every migration, every test is in this repo under
`apps/cloud/`. If `cloud.vx.dev` shuts down tomorrow, every customer
spins their own up in an afternoon.

The hosted SaaS we may eventually run will be one CF account
deployment of the same template you just deployed — no special
branch, no closed-source modules, no "community edition" with
crippled features.

## Tests

```sh
cd apps/cloud
bun test tests/                          # HMAC compute/verify round-trips
```

Hardcoded into CI as the apps/cloud test task.

See also: `docs/design/vx-cloud-2026-06.md`,
`apps/cloud/README.md` (the deploy guide that ships with the template).
