# vx-cloud as an independent self-hosted CI platform — design

> **Status:** accepted by owner directive (2026-07-11) — architecture + phasing
> **Owner ask (verbatim):** "It should be a fully completely independent SaaS
> app! with full account creation, permission roles users, multi workspaces,
> repos, projects, teams, everything. It should be deployed as docker compose.
> It should be not possible to call vx-cloud serve. It is not companion. it
> requires setup of s3 db etc… it is not run next to vx thing. its a self
> hosted cloud solution that cover orgs of 100000 of devs and with millions of
> projects."
> **Builds on:** the native cache wire (`native-cache-wire-2026-07.md`), trust
> scopes (`cache-trust-scopes-2026-07.md`), the S3 blob backend
> (`s3-blob-backend-2026-07.md`), the entity model
> (`cloud-data-model-2026-07.md`), distribution (`distributed-execution-2026-07.md`,
> `universal-agents-2026-07.md`).

## 1. What we're solving

vx-cloud today is a **companion**: a `vx-cloud serve` you start next to a
workspace, tokenless on loopback, storing run history in per-workspace
SQLite files shaped like core's `cache.db`, executing delegated runs against
its own cwd, with exactly two static bearer tokens (trusted + PR). Every one
of those properties is wrong for the target the owner named: an independent,
self-hosted, multi-tenant CI platform an organization deploys ONCE, that
100k developers and millions of projects connect TO.

This doc is the pivot: accounts, orgs, teams, RBAC, workspaces/repos/projects
as first-class server-side entities, Postgres as the system of record, S3 as
the only artifact store, docker-compose as the deployment artifact, and the
death of every "runs casually next to vx" affordance.

## 2. Reversed prior decisions (explicit)

| Reversed decision                                                                                                                   | Was                                                                                      | Now                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-28 "vx-cloud serve --ui next to the workspace" (+ every colocated-workspace feature)                                        | zero-config local serve; `/v1/graph` planRun; WorkspaceCatalog; spawn = server-side exec | the `serve` verb is REMOVED; the server never has a workspace checkout; catalog becomes push-fed (§5.6); spawn rides distribution (§8.3)                    |
| 2026-06-28 / dev-flows §3.4 "one SQLite store per workspace" (`IngestStore` = core `Cache` at a cloud path)                         | per-workspace `cache.db` + `logs.db` + `fingerprints.db` + `workspaces.json`             | Postgres tables, org/workspace-scoped, partitioned (§5)                                                                                                     |
| 2026-07-03 security-wave auth model (static `--token`/`--pr-token`, tokenless-on-loopback, unix socket 0600 = auth)                 | two shared secrets; open local mode                                                      | accounts + sessions + minted per-purpose API tokens; NO tokenless mode, NO loopback exemption, NO socket listener (§6)                                      |
| 2026-06-17 / 2026-07-08 run delegation (`{t:'run'}` executes on the server's cwd; `connect --delegate`; the server-side `RunQueue`) | the server executes runs in-process                                                      | DIES — an independent platform has no checkout. Execution = agents only (dist protocol). The queue concept survives only as dist-submission ordering (§8.3) |
| 2026-07-11 (same-day) "Local-dir backend stays the zero-config default" (s3-blob-backend doc)                                       | LocalDirBackend reachable from env/boot                                                  | S3 is MANDATORY at boot; `LocalDirBackend` survives as a constructor-injected TEST seam only — never constructible from config (§7)                         |
| 2026-07-04 ghcr image = one container, one process, one volume                                                                      | SQLite volume                                                                            | compose stack: app + postgres + (optional) minio (§9)                                                                                                       |

NOT reversed: the client-side `environments.json` (`vx-cloud connect` is the
client's address book — it survives verbatim); the trusted/untrusted cache
tier security invariant (it becomes a TOKEN property, §6.4); the native
cache wire; the dist protocol; the ingest push contract; the dashboard's
single-dev product lens (§8.4); the ci-platform wedge's permanent non-goals
(git-event triggers, hosted runners, secrets management, marketplace/DSL —
the platform hosts DATA + coordination, compute still comes from your agents).

## 3. System shape

One compiled binary (`vx-cloud`), one meaningful entrypoint: **`vx-cloud
server`**. It hard-requires configuration (§7), serves everything on one
port: the dashboard SPA, `/v1/*` JSON API, the native cache wire, the agent
and dist WebSockets, `/mcp`. State lives in exactly two places:

- **Postgres** — the system of record: identity (users/orgs/teams/tokens/
  sessions), tenancy (workspaces/repos/projects), and analytics
  (invocations/task runs/logs/fingerprints).
- **S3-compatible bucket** — artifact bytes, period. The controller stores
  zero bytes at rest (the 2026-07-11 directive, already shipped; now the
  only mode).

The client side is unchanged in shape: `vx-cloud connect <url> --token …`
writes the per-user `environments.json`; the `cloud()` plugin resolves that
connection and drives ingest + remote cache + distribution. Nothing
auto-starts; a workspace CONNECTS to a deployed platform.

## 4. Access pattern (what the schema must serve)

At the stated scale ceiling (100k devs, millions of projects), rough
worst-case write rates: ~2M invocations/day (100k devs × ~20 runs), ~50-100M
task rows/day, bounded log tails (≤4 MiB/run cap, failures-first), small
fingerprint rows. Reads are the dashboard's per-workspace analytics (the
~40 queries in `src/orchestrator/metrics.ts` — always
`WHERE workspace … AND started_at >= window`, window ≤ 90d), plus admin
reads (members, tokens, org rollups) that are tiny. The cache wire is
hash-addressed and never touches Postgres on the hot path (S3 HEAD/PUT +
presigned GET). Conclusion: time-partition the two hot tables, lead every
index with `workspace_id`, drop old partitions for retention, and keep
identity tables boring.

## 5. Data model (Postgres, system of record)

### 5.1 Conventions

- PKs are UUIDv7 (`Bun.randomUUIDv7()` — time-ordered, index-friendly);
  generated app-side so inserts are one round-trip.
- Timestamps are `bigint` ms-epoch (matches every existing wire record; no
  tz ambiguity).
- All tenant-scoped tables carry BOTH `org_id` and `workspace_id`
  (denormalized on the hot tables so no join is needed to enforce scoping
  in the WHERE clause).
- No ORM. Hand-written SQL through `Bun.sql`. No RLS — scoping is enforced
  by the auth middleware composing every query's WHERE (one code path, §6.5);
  RLS would double the policy surface for zero attacker-model gain (the app
  is the only DB client).

### 5.2 Identity + tenancy (DDL sketch)

```sql
CREATE TABLE users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE,          -- stored lowercased
  display_name   text NOT NULL,
  password_hash  text NOT NULL,                 -- Bun.password argon2id
  instance_admin boolean NOT NULL DEFAULT false,
  disabled_at    bigint,
  created_at     bigint NOT NULL
);

CREATE TABLE organizations (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE,              -- [a-z0-9-]{1,64}
  name       text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE org_memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       org_role NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE TABLE team_memberships (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       text NOT NULL,        -- display/URL identity, admin-editable
  name       text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, slug)
);

-- A repo links a CLIENT workspace identity (core's 16-hex xxh3 of the
-- normalized git remote — what every pushed summary carries) to a server
-- workspace. One workspace may hold several repos (mirrors whose remote
-- URLs hash differently). Ingest routing = repos lookup within the token's
-- org (§5.5).
CREATE TABLE repos (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_workspace_id text NOT NULL,   -- the pushed workspaceId
  remote_url          text,            -- display only (workspaceName push)
  first_seen_at       bigint NOT NULL,
  last_seen_at        bigint NOT NULL,
  UNIQUE (org_id, client_workspace_id)
);

-- Projects/tasks: the catalog entities (millions of rows are fine — these
-- are plain indexed tables). Rows are upserted from ingested run rows
-- (name-only) and enriched by the catalog push (§5.6).
CREATE TABLE projects (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at  bigint NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE project_tasks (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task        text NOT NULL,
  config      jsonb,               -- resolved TaskConfig from the catalog push
  cacheable   boolean,
  is_group    boolean,
  persistent  boolean,
  updated_at  bigint NOT NULL,
  PRIMARY KEY (project_id, task)
);
```

### 5.3 Credentials

```sql
CREATE TYPE trust_tier AS ENUM ('trusted', 'untrusted');
CREATE TYPE token_kind AS ENUM ('ci', 'admin');

-- API tokens: minted by an org admin, shown ONCE, sha256 at rest.
-- trust_tier is IMMUTABLE after creation (change = revoke + mint) — a
-- mutable tier would create a window where artifacts written under one
-- tier are readable under another. This is the cache-trust-scopes
-- invariant carried into the account model.
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = org-wide
  name         text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,   -- sha256(secret)
  kind         token_kind NOT NULL DEFAULT 'ci',
  trust_tier   trust_tier NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   bigint NOT NULL,
  last_used_at bigint,
  expires_at   bigint,
  revoked_at   bigint
);

-- Dashboard sessions: opaque 256-bit ids, sha256 at rest. The cookie value
-- is `<id>.<hmac-sha256(VX_CLOUD_SECRET, id)>` so a tampered cookie is
-- rejected before a DB read; the DB row is the source of truth (revocable).
CREATE TABLE sessions (
  id_hash    bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  ip         text,
  user_agent text
);

-- Invites: no SMTP dependency — an admin creates an invite and copies the
-- URL out of the UI. Single-use, expiring, role-carrying.
CREATE TABLE invites (
  id         uuid PRIMARY KEY,
  org_id     uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = instance-level
  role       org_role,
  token_hash bytea NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_by    uuid REFERENCES users(id)
);
```

Token format: `vxc_<43 base64url chars>` (256 bits). Lookup is
`SELECT … WHERE token_hash = sha256(presented)` — an index probe on a
preimage-resistant digest, no comparison oracle. `last_used_at` is updated
at most once per minute per token (write-avoidance on the hot wire).

### 5.4 Analytics (the hot tables)

The per-task and per-invocation history that today lives in the SQLite
ingest stores. Renames: SQLite `runs` → `task_runs` (the "runs" name
collides with the invocation concept everywhere in the UI), `invocations`
keeps its name. Both are **declaratively partitioned by RANGE on
`started_at`** — `invocations` monthly, `task_runs` weekly (the 50-100M
rows/day ceiling makes monthly task partitions multi-billion-row; weekly
keeps each partition manageable and makes retention cheap). `task_logs`
partitions monthly. A boot-time + daily maintenance tick creates partitions
ahead and DROPs those past retention (`VX_CLOUD_RETENTION_DAYS`, default 180) — no pg_partman, ~80 LOC of hand-rolled DDL against a partition
catalog query.

```sql
CREATE TABLE invocations (
  run_id            text NOT NULL,          -- UUIDv7 from the client
  org_id            uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  command           text NOT NULL,
  requested_tasks   jsonb NOT NULL,
  cache_policy      text NOT NULL,
  concurrency       int NOT NULL,
  flow              text,
  started_at        bigint NOT NULL,
  ended_at          bigint NOT NULL,
  total_duration_ms int NOT NULL,
  task_count        int NOT NULL,
  failed_count      int NOT NULL,
  hit_count         int NOT NULL,
  hit_local_count   int NOT NULL,
  hit_remote_count  int NOT NULL,
  exit_ok           boolean NOT NULL,
  commit_sha        text,
  branch            text,
  dirty             boolean,
  ci                boolean NOT NULL,
  ci_provider       text,
  host              text,
  os                text,
  arch              text,
  vx_version        text NOT NULL,
  tags              jsonb NOT NULL DEFAULT '{}',
  ingested_by_token uuid,                   -- provenance, not authz
  PRIMARY KEY (started_at, run_id)          -- partition key must be in the PK
) PARTITION BY RANGE (started_at);
CREATE INDEX ON invocations (workspace_id, started_at DESC);
CREATE INDEX ON invocations (workspace_id, branch, started_at DESC);
CREATE UNIQUE INDEX invocations_run_id ON invocations (run_id, started_at);
-- Idempotency (re-delivered summary) is checked app-side by run_id within
-- the retention window (the same gate the SQLite store used); a global
-- UNIQUE(run_id) is impossible across partitions and unnecessary — run_id
-- is a client UUIDv7.

CREATE TABLE task_runs (
  org_id             uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  run_id             text NOT NULL,
  hash               text NOT NULL,
  project            text NOT NULL,
  task               text NOT NULL,
  status             text NOT NULL,
  exit_code          int NOT NULL,
  duration_ms        int NOT NULL,
  started_at         bigint NOT NULL,
  ended_at           bigint NOT NULL,
  cpu_ms             int,
  peak_rss_bytes     bigint,
  wallclock_start_ns bigint,
  wallclock_end_ns   bigint,
  cache_hit          boolean,
  attempts           int
) PARTITION BY RANGE (started_at);
CREATE INDEX ON task_runs (workspace_id, started_at DESC);
CREATE INDEX ON task_runs (workspace_id, project, task, started_at DESC);
CREATE INDEX ON task_runs (workspace_id, hash);
CREATE INDEX ON task_runs (workspace_id, run_id);

CREATE TABLE task_logs (
  org_id         uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  run_id         text NOT NULL,
  task_id        text NOT NULL,
  hash           text,
  status         text NOT NULL,
  codec          text NOT NULL DEFAULT 'plain',   -- 'plain' | 'zstd'
  content        bytea NOT NULL,                  -- bounded tail (≤128 KiB/task)
  chars_full     int NOT NULL,
  truncated_head int NOT NULL DEFAULT 0,
  created_at     bigint NOT NULL
) PARTITION BY RANGE (created_at);
CREATE INDEX ON task_logs (workspace_id, run_id, task_id);
CREATE INDEX ON task_logs (workspace_id, hash);
-- (run_id, task_id) uniqueness is enforced app-side by the idempotent
-- ingest gate — a cross-partition unique constraint is not expressible and
-- the bytes are bounded, so a rare duplicate is a wasted row, not a defect.

-- Output fingerprints (verify-cross-machine): small, unpartitioned.
CREATE TABLE output_fingerprints (
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL,
  hash         text NOT NULL,
  os           text NOT NULL,
  arch         text NOT NULL,
  tree         text NOT NULL,
  file_count   int NOT NULL,
  files        jsonb,
  truncated    boolean NOT NULL DEFAULT false,
  task_id      text NOT NULL,
  run_id       text NOT NULL,
  host         text,
  created_at   bigint NOT NULL,
  PRIMARY KEY (workspace_id, hash, os, arch, tree)
);
```

Query-fit check against the hot reads in `src/orchestrator/metrics.ts`:
`listRuns`/`listInvocations`/trends/heatmap/period-comparison scan
`(workspace_id, started_at)` — partition pruning + the leading index;
`getHistory`/`getTaskDetail`/flakiest/regressions/bottlenecks scan
`(workspace_id, project, task, started_at)`; `cacheKeyDiff`/artifact
provenance/log-by-hash use `(workspace_id, hash)`. Every existing query has
an index that serves it with partition pruning on the window.

### 5.5 Ingest routing (workspaceId → workspace)

A pushed summary carries core's client `workspaceId`. Routing, in order:

1. Token workspace-scoped → the summary MUST resolve (via `repos`) to that
   workspace; anything else is 403. A workspace-scoped token can never
   write another workspace's history.
2. Token org-scoped → look up `repos (org_id, client_workspace_id)`. Found
   → that workspace. Not found → **auto-provision**: create a workspace
   (slug from the pushed `workspaceName`, deduped) + the repo row. This is
   the Nx-Cloud-style first-push onboarding — at millions of projects,
   manual workspace pre-registration is operationally absurd. Admins can
   rename/merge afterward (repos are re-pointable).

### 5.6 Catalog push (replaces the colocated WorkspaceCatalog)

The colocated catalog (`/v1/workspace/*` reading `vx-lock.json` off the
server's disk) dies with the colocated workspace. Replacement: the client
pushes the catalog. `POST /v1/catalog` takes the lock-derived project list
(name, dir, per-task resolved config) — the `cloud()` telemetry sink ships
it when the lock's `configHash` fingerprint changes (one cheap comparison
against a server-echoed etag), and `vx-cloud push-catalog` does it
explicitly from CI. Server upserts `projects` + `project_tasks`. The
dashboard's Projects/Tasks/config-card surfaces read these tables — same
UX, push-fed. `/v1/graph` (colocated planRun) dies without replacement;
the run-detail DAG falls back to the edges reconstructible from recorded
task rows or renders the flamegraph only (honest degradation).

### 5.7 What DIES in the data layer

- `IngestStore` and the per-workspace `cache.db`-shaped SQLite stores —
  including the `Cache`-schema coupling (the "schema gate wipes server
  history" landmine gets structurally deleted, replaced by real migrations).
- `workspaces.json` manifest, `log-store.ts` (`logs.db`), `fp-store.ts`
  (`fingerprints.db`), `preGateInvocationCount`, `migrateLegacyStore`,
  `migrateLegacyFlatStore`.
- `WorkspaceCatalog` + `/v1/workspace/*` + `/v1/graph` (colocated features).
- serve-info is already dead (2026-07-08). Client-side `environments.json`
  SURVIVES untouched — it's the client's address book, not a server concept.

## 6. AuthN / AuthZ

### 6.1 Accounts and sessions

- Email + password. `Bun.password.hash(pw)` (argon2id defaults) /
  `Bun.password.verify` — zero deps, memory-hard.
- Dashboard auth = HttpOnly session cookie: `vx_session=<id>.<hmac>`,
  `HttpOnly; SameSite=Lax; Path=/; Secure` (Secure set when
  `VX_CLOUD_BASE_URL` is https). Opaque id, sha256 at rest, 30-day sliding
  expiry, revocable (a sessions admin page lists + kills them).
- CSRF: SameSite=Lax + every state-changing session-authenticated route
  requires the SPA's `x-vx-csrf: 1` custom header (forces a CORS preflight
  a cross-site form can't produce). No token dance needed.
- Login throttling: in-memory per-IP+email counter with exponential
  backoff (P1; a reverse proxy adds real rate limiting, §9).
- CORS: the Bearer-token API surfaces keep permissive CORS (tokens aren't
  ambient credentials). The session/auth routes send NO CORS headers —
  cookies are same-origin only, and the SPA is served by the platform
  itself.

### 6.2 Bootstrap

**First registered user becomes instance admin.** Registration is open
while `users` is empty; the moment the first account exists, open signup
closes (joining then requires an invite link, or `VX_CLOUD_OPEN_SIGNUP=1`
for permissive instances). Chosen over a `VX_CLOUD_BOOTSTRAP_ADMIN` env:
compose-up → open browser → register is the smoothest self-hosted flow
(the Gitea/Grafana model), and it keeps a plaintext admin password out of
env files and `docker inspect`. The bootstrap window race (a hostile party
registering first on a fresh public deployment) is real but marginal —
deploy, register, done; noted in §12.

### 6.3 Roles (minimal set)

- **Instance admin** (flag on `users`): everything, across orgs; the only
  role that creates organizations (or enable `VX_CLOUD_OPEN_ORG_CREATE=1`).
- **Org roles:** `owner` (admin + delete org + manage owners), `admin`
  (manage members/teams/tokens/workspaces), `member` (use: view all org
  data, spawn dist runs, create/cancel own runs), `viewer` (read-only).
- **Teams** are grouping/mention/ownership metadata in this design —
  team-scoped PERMISSIONS (restricting workspaces to teams) are deliberately
  out of scope for v1 (§13): every role above is org-wide. The tables exist
  so the UI can model ownership now and permissions can attach later
  without a schema break.

### 6.4 API tokens

Two kinds. **`ci` tokens** are what CI jobs, agents, and `vx-cloud connect`
carry: scoped to an org (optionally narrowed to one workspace), carrying an
immutable `trust_tier`. **`admin` tokens** additionally unlock the org
admin mutations over the API (for IaC/provisioning; kind implies tier
`trusted`). Minted in the dashboard (org admin) or via
`vx-cloud token create` (authenticated by email+password login → short
session, or an existing admin token). Shown once, hash at rest.

**The trust tier is a token property, set at creation, immutable.** The
fork-PR flow becomes: an org admin mints an `untrusted` ci token and puts
it in the public-PR CI context; the trusted token stays in the protected
context. Byte-identical semantics to today's `--pr-token`, minus the
static shared secret.

### 6.5 Surface → required principal (complete map)

| Surface                                               | Principal required                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                         | none (liveness; no data)                                                                                                          |
| `GET /v1/meta`                                        | none — name, version, `auth: 'account'`, capability flags ONLY (workspace counts and any tenant data REMOVED — multi-tenant leak) |
| `POST /v1/auth/register`                              | open only during bootstrap window / with invite token / `VX_CLOUD_OPEN_SIGNUP`                                                    |
| `POST /v1/auth/login`, `/logout`                      | credentials / session                                                                                                             |
| `POST /v1/ingest`, `/v1/ingest/logs`, `/v1/catalog`   | ci token; writes routed + clamped to the token's org(/workspace) (§5.5)                                                           |
| `/v1/cache/:hash` GET/HEAD                            | ci token; read scopes derived from token org/workspace + tier (§8.1)                                                              |
| `/v1/cache/:hash` PUT                                 | ci token; write scope = token tier partition                                                                                      |
| `/v1/agents` WS + capacity GET                        | ci token; sessions keyed inside the token's org+workspace                                                                         |
| run WS `dist:submit`                                  | ci token (same org+workspace as the pool)                                                                                         |
| `GET /v1/*` analytics, `/mcp`                         | session (org `viewer`+) or ci token; every query WHERE-clamped to the principal's org/workspace                                   |
| org/team/member/token/workspace admin (`/v1/admin/*`) | session org `admin`/`owner` (or `admin` token); instance admin everywhere                                                         |
| UI catch-all (SPA static)                             | open (static code; every data call is gated)                                                                                      |

One middleware resolves `Principal` per request:
`{ kind: 'session', userId, orgs: Map<orgId, role>, instanceAdmin }` or
`{ kind: 'token', orgId, workspaceId?, tier, tokenKind }`. Route handlers
declare their requirement; scoping composes into every SQL WHERE through a
single helper — there is exactly ONE place that turns a principal into a
`(org_id, workspace_id)` clamp.

## 7. Runtime: Bun.sql, migrations, config-required boot

### 7.1 Database access

`Bun.sql` — Bun's built-in Postgres client (tagged-template parameterized
queries, connection pool). Zero new deps, house rule intact. A thin
`packages/cloud/src/db/client.ts` owns the pool + a `withTx` helper. No
ORM, no query builder: the analytics port is hand-written SQL exactly like
`metrics.ts` today, just Postgres dialect.

### 7.2 Migrations

Numbered SQL files, `packages/cloud/src/db/migrations/NNNN_name.sql`,
embedded in the binary (compile-time imports). At boot:
`SELECT pg_advisory_lock(k)` → create `schema_migrations(version int pk,
applied_at)` if absent → apply pending files in order, each in a
transaction → unlock. Concurrent boots (compose scale, restarts) serialize
on the advisory lock. **Migrations are forward-only and additive-biased**;
this replaces — and finally fixes — the SQLite "schema gate wipes history"
model, which was acceptable for a cache and a documented landmine for a
server.

### 7.3 Multi-node posture (honest)

Single **app-node** today, by design, stated plainly:

- **In-memory and single-node:** the agent session registry (`dist/
registry.ts`), dist scheduling state, live WS fan-out, the login
  throttle. Two app replicas would split agent pools and lose submissions
  on the wrong node.
- **Already multi-node-safe:** everything in Postgres and S3 (identity,
  analytics, artifacts) and the stateless read API.
- **The path (future, NOT a phase in this doc):** agents and their
  submitters must land on the same node → sticky routing by
  `{org, workspace, session}` (an L7 hash) OR a Postgres-backed dispatch
  queue (`FOR UPDATE SKIP LOCKED`) with per-node WS ownership published in
  a `node_agents` table. Both are additive; nothing in this design blocks
  them. Postgres does the storage scaling long before the single app node
  saturates on coordination (it holds WS connections and routes JSON — the
  heavy bytes go client↔S3).

Scale-out for the stated ceiling is therefore: one beefy app node + big
Postgres + S3, then the sticky-routing work when agent-pool concurrency
actually demands it.

### 7.4 `vx-cloud server` (the serve verb DIES)

`serve` is removed from the dispatcher (`cli/bin.ts`) — invoking it prints
"vx-cloud is a self-hosted platform now: run `vx-cloud server` (see the
self-hosting guide)". The new entrypoint:

```
vx-cloud server
  DATABASE_URL                    (required) postgres://…
  VX_CLOUD_SECRET                 (required) ≥ 32 chars; session-cookie HMAC
  VX_CLOUD_BASE_URL               (required) public origin, e.g. https://vx.acme.dev
  VX_CLOUD_S3_ENDPOINT            (required)
  VX_CLOUD_S3_BUCKET              (required)
  VX_CLOUD_S3_ACCESS_KEY_ID       (required)
  VX_CLOUD_S3_SECRET_ACCESS_KEY   (required)
  VX_CLOUD_S3_REGION / _PREFIX / _PRESIGN_TTL   (optional)
  VX_CLOUD_PORT                   (optional, default 4321)
  VX_CLOUD_RETENTION_DAYS         (optional, default 180)
  VX_CLOUD_OPEN_SIGNUP / _OPEN_ORG_CREATE       (optional, default off)
```

Boot validates the FULL set and refuses listing **every** missing/invalid
var at once (not first-failure — an operator fixes one env file pass, not
five boot loops). Then: migrate (advisory lock) → probe S3 (HEAD bucket) →
listen. **Removed with the verb:** the tokenless/open mode, the
loopback-implies-trusted default, `--host` gymnastics (bind `0.0.0.0`
always — compose is the deployment), the unix-socket listener and its
0600-as-auth model, `VX_CLOUD_TOKEN`/`VX_CLOUD_PR_TOKEN` static tokens,
`--ui` (the SPA always serves), `/version`'s workspace-path leak.

**LocalDirBackend survives as a test seam only.** `ArtifactStore` keeps
its injectable `BlobBackend` constructor and unit tests keep exercising
policy (scopes, immutability, caps, zstd gate) against a local dir — cheap
and hermetic. It is NOT constructible from `server` config; there is no
env combination that stores artifact bytes on the controller. (Deleting it
entirely would force every store-policy unit test through the fake-S3
helper for zero coverage gain.)

## 8. What survives, re-scoped

### 8.1 Native cache wire

`/v1/cache/:hash` GET/HEAD/PUT survives byte-compatible on the client side.
Server-side, the scope key grows tenancy:
`org/<orgId>/ws/<workspaceId>/<tier>[/<sub>]/<hash>.tar.zst` — the
`Principal.bucket` placeholder from `cache-trust-scopes-2026-07.md` Phase 2
finally becomes real, derived from the token. All existing invariants hold
by construction: tier partitioning, per-PR sub-scopes
(`x-vx-cache-scope` still client-supplied WITHIN untrusted only),
immutability 409, streaming caps, zstd-magic gate, presigned-GET 307 with
bearer/scope dropped cross-origin. `/v1/artifacts` lists within the
token's derived prefix; provenance joins `task_runs` on
`(workspace_id, hash)`.

### 8.2 Distribution / agents

The dist protocol and agent loop survive unchanged on the wire. Registry
sessions re-key from `{workspaceId, session}` to
`{orgId, workspaceId, session}` derived from the agent's token (the
client-pushed workspaceId maps through `repos` like ingest). Agents holding
an `untrusted` token write untrusted cache scopes — the tier rides the
token end-to-end, no new mechanism.

### 8.3 Run operations in the UI

Server-side execution is gone, so: the spawn bar submits **dist**
runs to a connected agent pool for the workspace and is honest-disabled
(with the pool-capacity hint) when no agents are connected; queued/live
rows render from dist submissions. "Trigger MULTIPLE from the UI" survives
— against pools, which is what a platform for 100k devs meant anyway.
`RunQueue` (serialize-on-server-cwd) dies with delegation; ordering within
a pool is the dist scheduler's existing fair-share.

### 8.4 Dashboard + product lens

The SPA survives and gains: a login screen, an org switcher, and an
**Admin area** (Members, Teams, Tokens, Workspaces, Settings) — new
surfaces, session-gated. The entity IA re-roots as
`org → workspace → {Runs · Projects · Tasks · Cache · Artifacts · Insights}`
— one nav level above today's seven entries. **The single-dev lens
(standing owner directive) governs the run/task/project surfaces
unchanged**: the five dev questions still answer within a workspace in the
same click-distance; the platform ADDS admin surfaces beside them, it does
not turn the dev pages into org-analytics mush. Org-level rollups live
only in the admin area.

### 8.5 Client (`cloud()` + connect)

`vx-cloud connect <url> --token vxc_…` unchanged; `environments.json`
unchanged (the `delegate` field dies with delegation — reject-with-hint on
read). The plugin ladder (explicit env → active environment → decline) is
untouched; ingest/cache/distribute rungs work against the platform with a
ci token. `/v1/meta` keeps advertising capabilities pre-auth (`cacheWire`,
`trustTiers`, now `auth: 'account'`).

## 9. Deployment: docker-compose is THE artifact

`packages/cloud/deploy/docker-compose.yml` (rewritten):

```yaml
services:
  vx-cloud:
    image: ghcr.io/vznjs/vx-cloud:latest
    ports: ['4321:4321']
    environment:
      DATABASE_URL: postgres://vx:${POSTGRES_PASSWORD:?}@postgres:5432/vx
      VX_CLOUD_SECRET: ${VX_CLOUD_SECRET:?openssl rand -hex 32}
      VX_CLOUD_BASE_URL: ${VX_CLOUD_BASE_URL:?e.g. https://vx.acme.dev}
      VX_CLOUD_S3_ENDPOINT: ${VX_CLOUD_S3_ENDPOINT:-http://minio:9000}
      VX_CLOUD_S3_BUCKET: ${VX_CLOUD_S3_BUCKET:-vx-artifacts}
      VX_CLOUD_S3_ACCESS_KEY_ID: ${VX_CLOUD_S3_ACCESS_KEY_ID:?}
      VX_CLOUD_S3_SECRET_ACCESS_KEY: ${VX_CLOUD_S3_SECRET_ACCESS_KEY:?}
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck: { test: ['CMD', 'vx-cloud', 'healthcheck'] } # GET /health
    restart: unless-stopped
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: vx
      POSTGRES_DB: vx
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U vx'] }
  minio: # optional: `--profile local-s3`
    profiles: ['local-s3']
    image: minio/minio
    command: server /data
    volumes: ['miniodata:/data']
volumes: { pgdata: {}, miniodata: {} }
```

- Quickstart: `docker compose --profile local-s3 up` (MinIO + a one-shot
  bucket-create sidecar in the profile); production points the S3 vars at
  R2/AWS/MinIO-elsewhere and omits the profile.
- **Migrations run in-app at boot** (advisory-locked) — no separate
  migration service/job; a compose `up` after image upgrade migrates
  itself.
- Secrets guidance in `deploy/README.md`: `.env` file (chmod 600),
  `openssl rand -hex 32` for `VX_CLOUD_SECRET` and the MinIO creds; TLS
  terminates at a reverse proxy in front (Caddy example in the README —
  the platform binds plain HTTP in the compose network).
- Dockerfile: build stages unchanged (compile binary, embedded SPA);
  `CMD ["server"]`; drops `EXPOSE`/env relics of the serve era. A tiny
  `vx-cloud healthcheck` verb (GET /health against localhost) keeps the
  container healthcheck dependency-free.

## 10. Test strategy: real Postgres, ephemeral, no mocks

`packages/cloud/tests/helpers/pg.ts`:

- One **cluster per test process**, lazily: `initdb` into a scratch dir,
  `postgres -k <sockdir> -c listen_addresses='' -c fsync=off` (unix socket
  only — no port contention, no TCP auth), wait for readiness.
- Apply all migrations ONCE into a `template_vx` database; each suite (or
  test needing isolation) gets `CREATE DATABASE t_<n> TEMPLATE template_vx`
  — milliseconds per copy, full isolation, real DDL.
- Teardown: `pg_ctl stop -m immediate`, rm scratch.
- Postgres 16 is present in this dev env (16.13 at
  `/usr/lib/postgresql/16/bin`) and on GitHub `ubuntu-latest` runners; the
  helper resolves the bin dir via `pg_config`/known paths and fails loud
  with an install hint.
- S3 in tests stays the existing fake-S3 helper (already records
  credentialed-presign violations).

No SQLite fallback in cloud tests, no query mocks — the metrics-port suite
runs every analytics query against real Postgres with seeded rows (the
existing drift-guard "every query runs against a fresh schema" pattern,
re-targeted).

## 11. Migration / compatibility

- **No data migration.** Pre-alpha: existing SQLite ingest stores and
  local-dir artifact stores are abandoned, stated in the changelog. The
  `migrateLegacy*` code paths are deleted, not ported.
- **Client compat:** `cloud()` plugin, connect, cache wire, dist protocol
  are wire-unchanged; the only client-visible change is that tokens are
  minted (format `vxc_…`) and delegation is gone.
- **Test suite transition (379 cloud tests today):**
  - _Die with companion mode:_ `serve-socket.test.ts` (socket listener),
    `workspace-catalog.test.ts` (colocated catalog), `run-queue.test.ts`
    (server-exec queue), the serve.test.ts cases for tokenless/loopback/
    legacy-migration/delegation, `dev.test.ts` cases touching delegation.
  - _Re-target onto the pg fixture:_ `ingest.test.ts`, `log-store` →
    analytics-port suites, `fp-store.test.ts`, `analysis-serve` /
    `regressions-serve` / `task-logs-serve` / `mcp-serve` (boot helper
    switches from `startServe` to `startServer({ dbUrl, s3, secret })`).
  - _Unchanged:_ `blob-sigv4`, `blob-store-s3`, `artifact-store` (policy
    units on the injected local backend), `native-cache`, `wire-dist`,
    `dist-registry`/`scheduler`/`multirun` (registry keying param widens),
    `environments`, `env-cli`, `github-*`, `task-log-capture`, `plugin`
    (ladder untouched).
  - _New:_ auth/RBAC suite, migrations suite, admin-API suite, bootstrap
    flow, token lifecycle, ingest-routing/auto-provision, catalog push.

## 12. Phasing

Each phase lands gate-green and independently shippable. `startServe`
survives as an **internal transitional export** (not a CLI verb) until P4
so un-migrated suites keep passing between phases.

**P1 — Platform skeleton (identity, auth, `server`)**
Postgres client + migrations runner + ephemeral-pg fixture; migrations
0001-0003 (identity/tenancy/credentials, §5.2-5.3); auth middleware
(sessions, tokens, RBAC map §6.5) as a self-contained module;
`/v1/auth/*` + `/v1/admin/*` routes; `vx-cloud server` entrypoint with
full config validation (fail listing all missing vars), S3 probe, S3-only
artifact store; `serve` verb removed from the dispatcher; bootstrap +
invites + login throttle. The analytics/ingest surfaces are mounted on
`server` still backed by the SQLite `IngestStore` **temporarily,
namespaced per org/workspace on the data volume** — an honest, named
transitional state so P1 ships a working platform while P2 does the
storage swap.
_Files:_ new `src/db/{client,migrate,migrations/*}.ts`, `src/auth/*.ts`,
`src/cli/server.ts`; touched `cli/bin.ts`, `artifact-store.ts` (principal
type), `deploy/*` (minimal). _Breaks:_ `vx-cloud serve` invocations;
tokenless/local flows. _Tests:_ new auth/migrations/bootstrap suites on
the pg fixture; serve suites keep passing via `startServe`.
_Size:_ L (~3-4k LOC incl. tests).

**P2 — Analytics on Postgres (the storage swap)**
Migrations 0004-0006 (§5.4 partitioned tables + partition maintenance);
`src/db/analytics.ts` — the Postgres port of the ~40 `metrics.ts` read
queries, org/workspace-clamped, response shapes imported from core's
façade types so the wire contract cannot drift (core's `metrics.ts` stays
untouched — it serves LOCAL `cache.db` for `vx mcp`/`vx info`; the dialect
fork is deliberate and named); ingest/logs/fp write paths → Postgres;
ingest routing + auto-provision (§5.5); catalog push (§5.6);
`IngestStore`/`log-store`/`fp-store`/`workspaces.json` DELETED.
_Breaks:_ any P1 deployment's transitional SQLite history (discarded —
pre-alpha). _Tests:_ full analytics-port suite against seeded pg; ingest
routing matrix; retention/partition tick. _Size:_ XL (~4-6k LOC — the
biggest phase; the queries port mechanically but each needs a seeded
pinned test).

**P3 — Cache wire + distribution under org tokens**
Scope keys grow the `org/<id>/ws/<id>/` prefix; `Principal` becomes the
token-derived `{orgId, workspaceId?, tier}`; `/v1/artifacts` provenance
joins `task_runs`; agent registry re-keys `{org, workspace, session}`;
`dist:submit` under ci tokens; **delegation dies** (`{t:'run'}` server
exec, `RunQueue`, `/v1/graph`, `connect --delegate`).
_Files:_ `artifact-store.ts`, `dist/registry.ts`, `dist/scheduler.ts`,
`cli/server.ts` routes, `plugin.ts` (drop delegate rung),
`environments.ts` (reject `delegate`). _Breaks:_ delegation users (the
release note names dist as the replacement). _Tests:_ trust-scope matrix
re-pinned with org/ws prefixes; dist e2e under minted tokens; deleted
delegation suites. _Size:_ M (~1.5-2k LOC).

**P4 — Dashboard auth + admin UI + IA re-root**
Login view, session handling in `api.ts`, org switcher, Admin area
(Members/Teams/Tokens/Workspaces/Settings), IA re-rooted org → workspace,
spawn bar re-targeted to dist pools (honest-disabled); `startServe`
transitional export DELETED, remaining companion suites removed.
_Files:_ `packages/cloud/ui/*` (views + api + shell), `cli/serve.ts`
deleted (fully absorbed into `server.ts`). _Tests:_ UI unit suites +
Playwright against a compose-like stack (pg fixture + fake S3).
_Size:_ L (~2-3k LOC, mostly UI).

**P5 — Compose, image, docs**
Rewritten `deploy/docker-compose.yml` (§9) + README (secrets, TLS proxy,
external-S3 vs `--profile local-s3`), Dockerfile `CMD ["server"]` +
`healthcheck` verb, self-hosting/dashboard/distributed-ci/extensibility
guides rewritten for the platform, `docker.yml` CI unchanged in shape.
_Size:_ S-M (~500 LOC + docs).

_(Future, explicitly not a phase: multi-app-node — sticky agent routing or
pg-backed dispatch; team-scoped permissions; SSO/OIDC; audit log.)_

## 13. Out of scope

- **Git-event triggers, hosted runners, secrets management, marketplace/
  DSL** — the ci-platform wedge's permanent non-goals hold; compute comes
  from your agents, events from your CI invoking `vx run`.
- **Email/SMTP** — invites and password resets are admin-driven links, no
  mail dependency.
- **SSO/OIDC/SAML, SCIM** — email+password v1; the sessions/principal
  seam is where OIDC attaches later.
- **Team-scoped permissions** (teams are metadata in v1, §6.3).
- **Data migration from SQLite stores** (pre-alpha, §11).
- **Multi-app-node HA** (§7.3 — path stated, not built).
- **Rate limiting beyond login throttle; WAF; audit log** — reverse-proxy
  guidance in the deploy README.
- **PUT offload to S3** (client→bucket presigned upload) — stays deferred
  from the blob-backend design; PUT keeps proxying so server gates hold.

## 14. Risks / honest costs

- **Scope.** This is the largest single pivot in the project's history
  (~12-16k LOC across five phases, dwarfing the core/cloud split). The
  phasing is designed so a stall after any phase still leaves a shippable
  system, but P2 (the query port) is a long grind with little visible
  novelty.
- **Bun.sql maturity.** The built-in Postgres client is young relative to
  node-postgres (pool behavior under WS-heavy load, prepared-statement
  cache, error taxonomy). Mitigation: the thin `db/client.ts` seam means a
  swap to a vendored minimal client is one file; the pg-fixture tests
  exercise the real driver constantly.
- **Dialect fork drift.** `db/analytics.ts` duplicates `metrics.ts`
  semantics in another dialect. Mitigation: shared response types from the
  core façade + per-query pinned tests with identical seed fixtures on
  both sides. Residual: semantic drift a type can't catch (window edges,
  NULL folding) — the 2026-07-10 `periodStats` NULL bug class; the port
  must carry those regression pins over.
- **Bootstrap window.** First-user-becomes-admin on a public endpoint is a
  race (deploy → register immediately). Named; acceptable for self-hosted
  (the Gitea model); `VX_CLOUD_OPEN_SIGNUP` stays off by default.
- **Partition maintenance is hand-rolled** (~80 LOC + a daily tick).
  Failure mode: inserts into a missing future partition error loudly —
  mitigated by creating 2 periods ahead at boot AND on tick, plus a
  default catch-all partition so ingest never drops data.
- **Delegation removal** breaks the "spawn against the serve's own
  checkout" flow some tests/demos leaned on. The replacement (dist pools)
  needs at least one connected agent — the UI must be honest about that,
  or spawn looks broken.
- **P1's transitional SQLite-under-org state** temporarily contradicts
  "requires setup of db" purity for the history surface (identity + cache
  ARE on pg/S3 from P1). Named deliberately: the alternative (P1+P2 as one
  mega-phase) risks a multi-week un-shippable trunk.

## 15. Why this is the right move

- **The security model finally matches the exposure.** A network-reachable
  service executing tasks and storing org data should never have had a
  tokenless mode or two shared static secrets; accounts + minted scoped
  tokens + the tier-as-token-property carry the one invariant that matters
  (untrusted can never write trusted) into a real tenancy model.
- **Postgres kills a whole landmine class** — the core-`Cache`-schema
  coupling where a vx upgrade could wipe a server's run history becomes
  real forward-only migrations.
- **The hot path stays fast by construction:** the cache wire is
  S3-addressed and never touches Postgres; analytics writes are batched
  ingest; the partition scheme serves every existing metrics query with
  pruning.
- **Almost everything valuable survives:** the wire contracts, the
  dashboard, the plugin, distribution, trust scopes — the pivot replaces
  storage + auth + entrypoint, not the product.
- **Compose-up → register → connect** is a genuinely deployable story for
  the stated audience, and each phase ships something real on the way.
