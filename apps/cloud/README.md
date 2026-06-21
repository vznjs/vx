# @vzn/vx-cloud

vx Cloud is a Cloudflare Workers reference deployment for hosted
observability, cache, and execution for `@vzn/vx`. Same code runs the
hosted SaaS at `cloud.vx.dev`; clone it, deploy into your own CF
account, and you have a private hosted vx for your team.

See [`docs/design/vx-cloud-2026-06.md`](../../docs/design/vx-cloud-2026-06.md)
for the architecture rationale and
[`docs/design/wire-protocol-2026-06.md`](../../docs/design/wire-protocol-2026-06.md)
for the JSON-RPC 2.0 envelope every endpoint speaks.

## Bindings at a glance

| Binding           | Type                    | Purpose                                                       |
| ----------------- | ----------------------- | ------------------------------------------------------------- |
| `DB`              | D1                      | orgs, members, api_tokens, runs, run_tasks, run_events        |
| `ARTIFACTS`       | R2                      | content-addressed cache artifacts, per-org key prefix         |
| `TOKEN_CACHE`     | KV                      | bearer-token → (org, role) lookup cache (TTL 60s)             |
| `EVENT_INGEST`    | Queue                   | buffer for `/v1/events/ingest`, consumer batches into D1      |
| `RUN_COORDINATOR` | Durable Object          | one DO per live run; holds graph + WS subscribers             |
| `INFLIGHT_DEDUP`  | Durable Object          | one DO per task hash; first-claim wins, others wait           |

## Routes

| Method | Path                          | Purpose                                                |
| ------ | ----------------------------- | ------------------------------------------------------ |
| GET    | `/`                           | minimal status landing page                            |
| GET    | `/health`                     | `{ok: true}`                                           |
| GET    | `/version`                    | protocol version + supported channels + RPC methods    |
| PUT    | `/v8/artifacts/:hash`         | Turbo-wire cache PUT (HMAC-validated when key set)     |
| GET    | `/v8/artifacts/:hash`         | Turbo-wire cache GET (HMAC-verified when key set)      |
| HEAD   | `/v8/artifacts/:hash`         | R2 head check                                          |
| POST   | `/v1/events/ingest`           | batched WireEvent uploader → queue → D1                |
| GET    | `/v1/runs`                    | list org runs (most-recent first)                      |
| GET    | `/v1/runs/:runId`             | single run + tasks                                     |
| GET    | `/v1/runs/:runId/events`      | SSE stream of WireEvents for a run                     |
| GET    | `/v1/ws`                      | WS upgrade, delegates to `RunCoordinatorDO`            |

All `/v8/*` and `/v1/*` routes require `Authorization: Bearer <token>`.
Loopback (`localhost`, `127.0.0.1`) bypasses auth for local development.

## Deploy

```sh
# From this directory.
bun install

# One-time auth.
bun wrangler login

# Provision the bindings (each command prints an id — paste into wrangler.toml).
bun wrangler d1 create vx_cloud
#   → copy `database_id` into [[d1_databases]] block

bun wrangler r2 bucket create vx-cloud-artifacts
#   → no id needed; bucket_name is enough

bun wrangler kv namespace create TOKEN_CACHE
#   → copy `id` into [[kv_namespaces]] block

bun wrangler queues create vx-event-ingest
bun wrangler queues create vx-event-ingest-dlq

# Apply the D1 schema.
bun wrangler d1 migrations apply vx_cloud

# (Optional) HMAC signing key for cache artifacts — Turbo-wire-compatible.
bun wrangler secret put VX_REMOTE_CACHE_SIGNATURE_KEY

# Deploy.
bun wrangler deploy
```

The deploy URL prints at the end: `https://vx-cloud-<subdomain>.workers.dev`.
Point a `vx run` at it via:

```sh
export VX_REMOTE_CACHE_URL=https://vx-cloud-<subdomain>.workers.dev/v8/artifacts
export VX_REMOTE_CACHE_TOKEN=<a token you issued>
vx run build test
```

## Hyperdrive escape hatch

D1 caps a single database at 10 GB. When your team outgrows it, swap
the `[[d1_databases]]` block for a [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
binding pointing at an external Postgres (RDS, Neon, Supabase). The
schema in `migrations/0001_init.sql` is compatible Postgres syntax
modulo `STRICT` keywords — port directly.

## Status

This is a **scaffold** (2026-06-21). Handlers are wired and persist to
the right backends, but several pieces are TODO-marked:

- HMAC signing/verification on cache PUT/GET
- per-run monotonic `seq` allocation in the queue consumer
- `submit.run` graph fan-out in `RunCoordinatorDO`
- waiter broadcast from `InflightDedupDO`
- GitHub OAuth login flow

Track progress in [`docs/progress/`](../../docs/progress/).
