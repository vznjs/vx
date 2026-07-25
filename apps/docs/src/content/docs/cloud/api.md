---
title: HTTP API reference
description: Every HTTP endpoint the vx Cloud platform serves — auth classes, parameters, body caps, and tenancy clamps.
---

Everything the dashboard shows and the `cloud()` plugin pushes rides
plain HTTP against the platform — the wire is the SDK. This page
enumerates that surface: every endpoint, who may call it, its
parameters and defaults, and the errors a scripter will actually hit.
The machine wire's *semantics* (cache artifact format, stream framing,
distribution messages) live in [Wire protocol](/vx/cloud/wire-protocol/);
this page is the route map.

All requests and responses are JSON unless noted. The base URL is your
deployment's origin (the `VX_CLOUD_BASE_URL` the server was booted
with).

## Authentication classes

| Class | How | Used by |
| --- | --- | --- |
| **Anonymous** | nothing | `/health`, `GET /v1/meta`, `POST /v1/auth/register`, `POST /v1/auth/login` |
| **Session** | the HttpOnly cookie set by login/register; every **mutation** must also send the header `x-vx-csrf: 1` or it 403s | the dashboard, anyone scripting with a cookie |
| **Machine token** | `Authorization: Bearer vxc_…` (minted under Admin → Tokens) | CI pushes, cache wire, agents, MCP |
| **Either** | session *or* token | analytics reads, streams |

Notes:

- The **cache wire, `/v1/cache/batch`, agent WS, and dist channels are
  machine-token-only** — a session cookie is answered 403 there.
- **Ingest writes require a token** (`ci token required` 403 for a
  session): history is pushed by machines, read by people.
- `?token=<bearer>` in the query string is accepted **only** on the
  WS/SSE endpoints (`/v1/agents`, `/events`, `/stream`), where browsers
  can't set headers. Everywhere else the header is required.
- `/version` intentionally returns 404 — `GET /v1/meta` is the identity
  probe.

## Tenancy resolution

Every data route is clamped to one `(org, workspace)`:

- **Token**: the org is derived server-side from the token row (never a
  client claim). A workspace-scoped token is pinned to its workspace; an
  org-wide token resolves `?ws=<workspace uuid>`, else the org's
  most-recently-seen workspace.
- **Session**: the org is `?org=<uuid>` when given, else the sole
  membership — a principal spanning several orgs without `?org=` gets a
  400 (`org query param required`). The workspace is `?ws=`, else the
  org's most-recent. Membership below `viewer` — and any org you can't
  see — answers **404, not 403** (existence is not leaked).
- An unknown `?ws=` is a 404. An instance admin may read any org (the
  operator superuser).

## Meta and health

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /health` | anonymous | liveness `{ ok: true }` |
| `GET /v1/meta` | anonymous | identity + capability flags: `auth: 'account'`, `artifacts`, `cacheWire: 2`, `trustTiers`, workspace count |

## Accounts and sessions — `/v1/auth/*`

| Route | Auth | Body / behavior |
| --- | --- | --- |
| `POST /v1/auth/register` | anonymous | `{ email, password (≥8), displayName?, invite? }`. The **first** registration becomes the instance admin (and gets a `Default` org as owner); after that signup is closed unless `VX_CLOUD_OPEN_SIGNUP` — an `invite` token is required (403 without). Sets the session cookie. 409 on a duplicate email. |
| `POST /v1/auth/login` | anonymous | `{ email, password }`. Throttled per-email **and** per-IP+email with backoff; every attempt runs one argon2 verify (no user-enumeration timing oracle). Rotates the session id. |
| `POST /v1/auth/logout` | session + CSRF | Destroys the session server-side, clears the cookie. |
| `GET /v1/auth/me` | session or token | The principal: `userId`, `email`, `displayName`, `instanceAdmin`, org memberships + roles. |
| `PATCH /v1/auth/me` | session + CSRF | `{ displayName }` (≤200 chars) — the only self-service profile field; email is the immutable login identity. |
| `POST /v1/auth/password` | session + CSRF | `{ currentPassword, newPassword (≥8) }` — verifies the current password before re-hashing. |
| `POST /v1/auth/invites/accept` | session + CSRF | `{ invite }` — joins an EXISTING signed-in user to the invite's org. The claim is atomic and single-use: of N concurrent accepts exactly one wins (the rest 403); 409 if already a member. A NEW user instead passes `invite` to `register`. |

Invites expire after 7 days and are single-use. Sessions renew on use
(30-day sliding window); cookies are `Secure` when `VX_CLOUD_BASE_URL`
is https.

## Admin — `/v1/admin/*`

All admin routes take a session or an **admin-kind** token; non-GET
methods with a session require the `x-vx-csrf: 1` header. The role
column is the minimum org role.

| Route | Role | Behavior |
| --- | --- | --- |
| `GET /v1/admin/orgs` | (member of any) | Your orgs, with roles. |
| `POST /v1/admin/orgs` | instance admin unless `VX_CLOUD_OPEN_ORG_CREATE` | `{ slug, name? }` — 409 on a taken slug. |
| `GET /v1/admin/orgs/:id` | viewer | The org + your role. |
| `PATCH /v1/admin/orgs/:id` | admin | `{ name?, slug? }` (slug `[a-z0-9-]{1,64}`). |
| `GET /v1/admin/orgs/:id/members` | viewer | Members + roles. |
| `PATCH /v1/admin/orgs/:id/members/:userId` | admin | `{ role }`. Managing an **owner** (either direction) requires org owner; the **last owner can never be removed or demoted** (applies to instance admins too). |
| `DELETE /v1/admin/orgs/:id/members/:userId` | admin | Remove the membership (same owner guards). |
| `POST /v1/admin/orgs/:id/invites` | admin | `{ role? (default member) }` — inviting an `owner` requires owner. Returns the invite token + a ready `…/register?invite=` URL (7-day expiry). |
| `GET /v1/admin/orgs/:id/tokens` | admin | List API tokens (metadata only — secrets are never re-shown). |
| `POST /v1/admin/orgs/:id/tokens` | admin | `{ name, tier: 'trusted'\|'untrusted', kind?: 'ci'\|'admin' (default ci), workspaceId?, expiresAt? }`. The plaintext `vxc_` secret exists exactly once: in this response. The trust tier is **immutable** for the token's life. |
| `DELETE /v1/admin/orgs/:id/tokens/:tokenId` | admin | Revoke — takes effect immediately (the in-process auth memo is cleared). |
| `GET /v1/admin/orgs/:id/workspaces` | viewer | Workspaces. |
| `POST /v1/admin/orgs/:id/workspaces` | admin | `{ slug, name? }` — 409 on a taken slug. |

Cross-org access answers 404. There is no invite-list endpoint —
invites are create-only surfaces.

## Analytics reads — `GET /v1/*`

Session (viewer+) or token; workspace-clamped per
[Tenancy resolution](#tenancy-resolution). Malformed numeric params are
ignored (the default applies); a malformed percent-encoding in a path
segment is a 400. Limits shown as `default/max` where the code clamps.

### Workspaces, runs, invocations

| Route | Params | Returns |
| --- | --- | --- |
| `/v1/workspaces` | — | The org's workspaces. |
| `/v1/runs` | `project`, `task`, `runId`, `limit` | Task-level run rows. |
| `/v1/runs/:id` | — | One full run (all task rows) or 404. |
| `/v1/runs/:id/logs/:taskId` | — | The task's captured log — `source: 'executed'` for a direct row, `source: 'cache'` (+ `refRunId`) when resolved through the producing run's cache hash; 404 when nothing was captured. |
| `/v1/invocations` | `branch`, `ci` (`1`/`true`), `tagKey`, `tagValue`, `limit` | Run-header rows (command, branch, commit, CI, tags, counts). |
| `/v1/invocations/:id` | — | One invocation header or 404. |
| `/v1/compare/:runId` | — | Per-task diff of the run vs the immediately-previous invocation. |

### Cache

| Route | Params | Returns |
| --- | --- | --- |
| `/v1/cache/stats` | `windowDays` (default 1) | Windowed hit/run counters. |
| `/v1/cache/hit-split` | — | Local-vs-remote hit split. |
| `/v1/cache/breakdown` | `limit` (20) | Per-project cache totals. |
| `/v1/cache/savings` | — | Time-saved estimate (24 h + all-time). |
| `/v1/cache/entries` | — | Cache-entry inventory. |
| `/v1/cache/prunable` | `minAgeDays` (7) | Entries eligible for pruning. |

### Trends and analysis

| Route | Params | Returns |
| --- | --- | --- |
| `/v1/trends/runs` | `bucket` (`hour`\|`day`, default hour), `from`, `to`, `project` | Bucketed runs/failures/hits series (span clamped server-side). |
| `/v1/trends/tasks` | **`project` required (400)**, `bucket` (default day), `from`, `to`, `limit` (≤50 tasks) | Per-task duration series for the project's heaviest tasks. |
| `/v1/trends/heatmap` | `days` (30) | 7×24 UTC build-activity grid. |
| `/v1/trends/storage` | `days` (30) | Storage growth series. |
| `/v1/trends/parallelism` | `limit` (50) | Per-run parallelism factors. |
| `/v1/analysis` | `window` (days), `minRuns`, `limit`, `project`, `task` | Period-over-period comparison: this window vs the prior one + the biggest duration movers. |
| `/v1/flakiness` | `limit` (25) | Flakiest tasks — retry-confirmed flakes ranked above inferred ones. |
| `/v1/regressions` | `sinceDays`, `minBranches`, `limit` | Tasks that started failing across ≥N branches and have a prior success. |
| `/v1/branch-failures` | **`project` required (400)**, `sinceDays`, `limit` | Per task: the branch where the failure was **first** noticed, first commit, and every failing branch. |
| `/v1/bottlenecks` | `days` (14), `limit` (15) | Aggregate critical-path bottlenecks. |
| `/v1/top-tasks` | `limit` (10) | Top time-burners. |
| `/v1/failures` | `limit` (25) | Recent failed tasks. |
| `/v1/notifications` | `limit` (20) | Recent broken invocations (the dashboard bell's feed). |
| `/v1/projects` | `limit` (100) | Per-project rollups. |
| `/v1/history` | `project`, `task`, `limit` | Per-task lifetime aggregates. |
| `/v1/hermeticity` | `limit` (50/500) | Cross-machine output-fingerprint divergences (`--verify=fingerprint` data). |

### Explainability

| Route | Returns |
| --- | --- |
| `/v1/tasks/:taskId` | Task detail (percentiles, durations, flakiness) or 404. |
| `/v1/explain/:taskId` | The task's cache-key composition. |
| `/v1/why/:runId` | **Batched**: every executed task's re-run verdict (first run / inputs changed / ran uncached) in one round-trip. |
| `/v1/why/:runId/:taskId` | One task's re-run verdict. |
| `/v1/triage/:runId` | **Batched failure triage**: every failed task's "is this failure mine?" verdict — `flaky` (the same cache key succeeded in other runs), `pre-existing` (the default branch's latest run of the task also fails), or `new-failure` (first failure of this key; `keyChanged` says whether this run altered the inputs) — with evidence run ids. |
| `/v1/diff/:runId/:taskId` | Cache-key component diff vs the previous run. |

`taskId` path segments are `project#task`, URL-encoded (`app%23build`).

## Ingest writes — token only

All four validate a wire version where shown — a version-skewed client
gets a 400 naming both versions. Bodies are read with a **streaming**
cap: an over-cap (or chunked-without-length) body aborts with 413, never
buffers. All are **idempotent** — a re-push of the same run/task
deduplicates instead of duplicating rows.

| Route | Cap | Body |
| --- | --- | --- |
| `POST /v1/ingest` | 32 MiB | A `RunSummaryRecord` — the end-of-run push; the completeness backstop for incremental task rows. |
| `POST /v1/ingest/task` | 2 MiB | One executed task's result + retained log tail (wire v1), sent as the task finishes — what makes the run-detail page fill in live. |
| `POST /v1/ingest/logs` | 16 MiB | The end-of-run log-tail bundle (wire-versioned). |
| `POST /v1/catalog` | 8 MiB | A workspace catalog push (`{ v: 1, workspaceId, projects }`) — resolved project/task metadata. |

The workspace is routed from the pushing token's org + the body's
client workspace id (auto-provisioned on first push); a
workspace-scoped token is refused a foreign workspace (403).

## Cache wire — machine token only

`HEAD/GET/PUT /v1/cache/:hash` (hex hash) and `POST /v1/cache/batch`
(`{ hashes: […] }`, ≤1024 per call, advertised as `cacheWire: 2` on
`/v1/meta`). Trust-scoped, immutable (re-PUT → 409), zstd-gated,
S3-offloaded via 307 presigned GETs. Semantics + headers:
[Wire protocol](/vx/cloud/wire-protocol/); trust tiers + sub-scopes:
[Remote caching](/vx/cloud/remote-caching/).

`GET /v1/artifacts?limit=` (default 200, max 1000) lists the store the
**caller's read scopes** can reach, with best-effort producing-task
provenance — a session or token surface.

## Live streams and agents

- `GET /events` / `GET /v1/events` — SSE stream of your org's
  distributed-run envelopes.
- `GET /stream` — the same as NDJSON.
- `GET /v1/agents?ws=&session=&commit=` — pool capacity probe
  (`agents`, `remoteAgents`, `capacity`, `remoteCapacity`, `ready`); the
  same path upgrades to the agent WebSocket. See
  [Distributed CI](/vx/cloud/distributed-ci/).

Cross-origin browser connections are refused unless allow-listed
(`VX_CLOUD_ALLOW_ORIGIN`); `?token=` works on these three.

## MCP

`POST /mcp` — JSON-RPC 2.0, seven read tools over the same analytics,
org/workspace-clamped like every read. See
[MCP over HTTP](/vx/cloud/mcp/).

## Error conventions

- `400` — missing/invalid required field, malformed request path, wire
  version mismatch (the body names both versions).
- `401` — no credential on a gated surface.
- `403` — session on a machine-token-only surface; ingest without a
  token; missing `x-vx-csrf` on a session mutation; insufficient role
  for an admin mutation.
- `404` — unknown id, unknown `?ws=`, or an org/workspace outside your
  tenancy (existence is never confirmed cross-tenant).
- `409` — immutability (cache re-PUT), duplicate email/slug, already a
  member.
- `413` — body over its streaming cap.
- Malformed *numeric* query params degrade to the default rather than
  erroring.
