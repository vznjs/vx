---
title: vx-cloud CLI
description: The vx-cloud binary — the self-hosted platform server plus the client verbs. vx-cloud server runs the platform; connect / env manage named environments; agent runs a distributed-execution worker; dev is the devtools hub.
---

The service layer lives in a **separate package, `@vzn/vx-cloud`**, which
ships its own `vx-cloud` binary. Core `vx` stays limited to discovery /
graph / cache / exec / the in-process run — it has no service CLI. The
`vx-cloud` binary is a prebuilt standalone binary per platform (with the
dashboard embedded), so `npm i -g @vzn/vx-cloud` gives you `vx-cloud` with
no Bun required.

```
bun add -D @vzn/vx-cloud        # or run it from the package's vx-cloud bin
```

Core integrates with the platform through the first-party `cloud()` plugin
— declare it in `vx.workspace.ts`
(`defineWorkspace({ plugins: [cloud()] })`) and every `vx run` pushes its
run summary to the connected platform, can distribute execution across an
agent pool, and can layer the shared cache. Anyone can write a different
plugin against the same `VxPlugin` interface (see
[Core is provider-neutral](/vx/guides/extensibility/)).

Typing `vx serve` / `dev` / `coordinator` / `worker` on the **core**
binary prints a redirect: those commands live here, not in core.

## Command surface

```
vx-cloud server       # the self-hosted platform (env-configured)
vx-cloud connect <url> [--name N] [--token T] [--distribute[=N]] [--no-use] [--force] [--anonymous]
vx-cloud env ls | use <name> | rm <name>
vx-cloud status
vx-cloud disconnect
vx-cloud agent --url <serve> [--token T] [--capacity N] [--session S] [--idle-timeout MS] [--label L]
vx-cloud dev
```

## `vx-cloud server` — the self-hosted platform

The platform entrypoint. One process, one port: accounts + orgs + RBAC on
Postgres, S3 artifact storage, the dashboard SPA, the `/v1/*` API, the
native cache wire, and the agent/dist channels. Configuration is
env-driven and REQUIRED — boot validates the full set and refuses,
listing **every** missing/invalid var at once:

```
vx-cloud server
  DATABASE_URL                    (required) postgres://…
  VX_CLOUD_SECRET                 (required) >= 32 chars; session-cookie HMAC
  VX_CLOUD_BASE_URL               (required) public origin, e.g. https://vx.acme.dev
  VX_CLOUD_S3_ENDPOINT            (required)
  VX_CLOUD_S3_BUCKET              (required)
  VX_CLOUD_S3_ACCESS_KEY_ID       (required)
  VX_CLOUD_S3_SECRET_ACCESS_KEY   (required)
  VX_CLOUD_S3_REGION / _PREFIX / _PRESIGN_TTL   (optional)
  VX_CLOUD_PORT                   (optional, default 4321)
  VX_CLOUD_RETENTION_DAYS         (optional, default 180)
  VX_CLOUD_OPEN_SIGNUP / _OPEN_ORG_CREATE       (optional, default off)
  VX_CLOUD_TLS_CERT / _TLS_KEY    (optional; PEM paths — both or neither.
                                   Terminate TLS in-process → HTTPS/1.1; use
                                   an edge proxy for HTTP/2 multiplexing)
  VX_CLOUD_DATA_DIR               (optional; the transitional analytics volume)
```

Boot: validate config → connect Postgres → run migrations
(advisory-locked, so concurrent compose boots serialize) → probe S3 (fail
loud — never a local fallback) → listen on `0.0.0.0`. The first registered
account (`POST /v1/auth/register`, or the dashboard) becomes the instance
admin and open signup closes; org admins mint invites and `vxc_…` API
tokens (the cache trust tier is a TOKEN property, immutable after mint).
Auth surfaces: `/v1/auth/*` (register/login/logout/me/invites) and
`/v1/admin/*` (orgs, members, invites, tokens, workspaces).

Full deployment reference — the docker-compose stack, every env var, TLS,
scale-out, and trust scopes — is on [Self-hosting](/vx/cloud/self-hosting/).

### HTTP surfaces

The platform serves everything on one port behind the account/token gate.
Auth is a session (dashboard login) or a `vxc_` API token; a programmatic
client presents `Authorization: Bearer <token>` (browser transports that
can't set headers use `?token=` on `/events`, `/stream`, and the WS
upgrade). Every read is tenant-clamped to the principal's org (and, for a
workspace-scoped token, its workspace). `/health` and `/v1/meta` are the
only pre-auth surfaces.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness probe (`200 ok`) — pre-auth |
| `GET /v1/meta` | Identity + capability flags (`auth`, `artifacts`, `cacheWire`, `trustTiers`) — pre-auth |
| `POST /v1/auth/*`, `/v1/admin/*` | Accounts / sessions / invites (auth) and org/member/token/workspace admin (RBAC) |
| `POST /v1/ingest/task` | Incremental push — one executed task's result + log tail, sent as the task finishes |
| `POST /v1/ingest` | End-of-run push — a `RunSummaryRecord` from the `cloud()` plugin (completeness backstop) |
| `GET /v1/artifacts` | List the artifact store (trust-scoped to the caller's READ scopes; task/run provenance) |
| `GET /v1/*` | Metrics/analytics API (runs, tasks, projects, cache, trends, compare, why, …), Postgres-backed |
| `HEAD/GET/PUT /v1/cache/:hash` | The vx-native artifact store (hex hash; the `cloud()` cache rung's target) |
| `POST /mcp` | MCP server for AI agents (JSON-RPC 2.0, plain-JSON responses) |
| `GET /events`, `GET /stream` | SSE / NDJSON stream of the caller's-org distributed-run envelopes (tenant-scoped; cross-origin refused) |
| `WS /v1/agents` (upgrade) | Distributed-execution agents rendezvous ({orgId, workspaceId, session} sessions) |

Notes:

- **Task reporting.** Each executed task is pushed as it finishes
  (`POST /v1/ingest/task`, result + log tail), so the run's detail page fills
  in live and a task's logs are queryable the moment it completes; the
  end-of-run summary (`POST /v1/ingest`, plus any remaining log tails via
  `POST /v1/ingest/logs`) is the completeness backstop, deduplicated against
  the incremental rows. Read a task's logs back at
  `GET /v1/runs/:runId/logs/:taskId`. Turn log capture off client-side with
  `cloud({ logs: false })` or `VX_CLOUD_LOGS=0`.
- **Artifact store.** `/v1/cache/:hash` is the vx-native cache wire — a
  connected `cloud()` plugin routes the remote cache here automatically, no
  separate cache server. PUTs stream to disk with the byte cap enforced on
  actual bytes; `x-vx-duration-ms` carries the producing task's duration
  and `x-vx-digest` (xxh3 over the artifact bytes) is stored and echoed on
  GET for client-side integrity verification. A PUT body that is not a zstd
  frame is refused (400) — the store is immutable, so a junk upload must
  never permanently lock a key. The store is **tenant- and trust-scoped**:
  artifact keys are `org/<orgId>/ws/<wsId>/<tier>[/<sub>]/`, ALL
  server-derived from the presented token. See
  [Remote caching](/vx/cloud/remote-caching/).
- **S3 artifact storage (mandatory).** The platform stores ZERO artifact
  bytes on the controller — `VX_CLOUD_S3_*` is REQUIRED at boot: a GET
  answers `307 Location: <pre-signed bucket URL>` (the client follows one
  hop, dropping the bearer + `x-vx-cache-scope` cross-origin — the bytes
  never transit the controller). A PUT still proxies THROUGH the server —
  transit, not storage: the byte cap, zstd-magic gate, immutability 409,
  and trust scopes stay server-enforced. Path-style addressing, hand-rolled
  SigV4 — works against MinIO, R2, Garage, and AWS itself.

  | Env var | Meaning |
  | --- | --- |
  | `VX_CLOUD_S3_ENDPOINT` | `https://…` — presence ENABLES the backend |
  | `VX_CLOUD_S3_BUCKET` | bucket name (required with endpoint) |
  | `VX_CLOUD_S3_REGION` | SigV4 region (default `auto`) |
  | `VX_CLOUD_S3_ACCESS_KEY_ID` | credentials (required with endpoint) |
  | `VX_CLOUD_S3_SECRET_ACCESS_KEY` | credentials (required with endpoint) |
  | `VX_CLOUD_S3_PREFIX` | optional key prefix (`vx-cache/`) |
  | `VX_CLOUD_S3_PRESIGN_TTL` | presigned-GET TTL in seconds, default `300` |

  Partial config (endpoint without bucket/credentials, or a malformed TTL)
  is a boot-time hard error naming the missing vars — the platform never
  silently falls back to local storage.
- **MCP.** `POST /mcp` is a dependency-free MCP server (JSON-RPC 2.0 over
  streamable HTTP, plain-JSON responses) exposing the dashboard's read
  surface as tools — `list_workspaces`, `list_runs`, `get_run`,
  `run_trends`, `cache_stats`, `why_did_rerun`, `compare_runs` — so an AI
  agent pointed at the platform (with a `vxc_` token as an `Authorization`
  header) can inspect and debug runs, org/workspace-clamped. See
  [MCP](/vx/cloud/mcp/).
- **Connecting.** The platform is never auto-detected — `vx-cloud connect`
  is the one client↔platform wiring: ONE-TIME
  `vx-cloud connect <url> --token vxc_…`; every `vx run` on the machine then
  pushes to it. (Run delegation was removed; the platform has no checkout to
  execute against. Distribution across an agent pool is the only remote
  execution — see `vx-cloud agent`.)

Every wire frame is a JSON-RPC 2.0 envelope (see
[Wire protocol](/vx/cloud/wire-protocol/)).

## `vx-cloud connect` / `env` / `disconnect` — environments

Docker-context-style **named server environments**, stored per-user in
`$XDG_CONFIG_HOME/vx-cloud/environments.json` (override:
`$VX_CLOUD_CONFIG`; mode `0600` — it holds tokens). Connect once; every
`vx run` on the machine then pushes its summary to the active server.

```
vx-cloud connect https://vx.corp.example --token vxc_…    # validate + persist + activate
vx-cloud connect <url> --name team --distribute --no-use  # named; opt into ambient distribution; don't activate
vx-cloud env ls                                           # named servers, with live reachability
vx-cloud env use team                                     # switch the active environment
vx-cloud env rm staging                                   # delete an entry
vx-cloud disconnect                                       # clear the active pointer (entries + tokens survive)
```

`connect` is a handshake: it probes `/health`, reads the server's identity
from `/v1/meta` (the default `--name`), errors if the server requires a
token and none was given, verifies a given token with one authenticated
request — and only then persists. `VX_CLOUD_ENV=<name>` overrides the
active pointer per-shell without touching the file.

**One connection drives everything.** `cloud()` resolves a SINGLE
connection and feeds all three capabilities from it — analytics ingest, the
remote cache (`/v1/cache`), and distributed execution. There is no separate
cache/ingest/service URL. Resolution (first match wins):

| # | The connection |
| --- | --- |
| 1 | `cloud({ url, token, prToken })` options / `VX_CLOUD_URL` + `VX_CLOUD_TOKEN` (+ `VX_CLOUD_PR_TOKEN`) |
| 2 | the active named environment (`vx-cloud connect`) |
| 3 | decline — a plain run stays zero-overhead |

There is no local-serve auto-detect: a platform merely reachable on the
network never captures runs by existence — connect to it explicitly
(`vx-cloud connect https://vx.corp.example`).

(The pre-consolidation env vars `VX_SERVICE_URL`, `VX_CLOUD_INGEST_URL/TOKEN`,
`VX_CLOUD_INSIGHTS_URL/TOKEN` are still accepted as aliases for the
URL/token, so existing setups keep working.)

- **Cache is internal to the connection.** A remote connection with a token
  wraps the local cache in a `LayeredCache` at `<url>/v1/cache`
  automatically. A third-party (e.g. Turbo-wire) cache server needs a cache
  plugin against core's `RemoteCacheLayer` seam — see
  [Core is provider-neutral](/vx/guides/extensibility/).
- **Trust follows the token.** Present `VX_CLOUD_TOKEN` (a trusted token) or
  `VX_CLOUD_PR_TOKEN` (an untrusted / fork-PR token — reads trusted, writes
  only untrusted). The platform derives the tier from the bearer; there is
  no trust flag and no fork-PR autodetection. Both tiers are minted under
  Admin → Tokens.
- **Execution never moves by default.** A plain connection NEVER moves
  execution off this machine. Distribution across an agent pool is the only
  remote execution, opt-in via `VX_CLOUD_DISTRIBUTE=<n>` (explicit) or an
  environment connected with `--distribute` (ambient, fails safe to a local
  run).

## `vx-cloud status` — connection doctor

One read-only screen that surfaces the failure modes the never-fail
clients hide by design. It prints: the resolved connection (explicit
`VX_CLOUD_URL` env vs the active environment) and whether a token is
present; server reachability + identity (`/health` + `/v1/meta`); an
**authenticated probe** that names a rejected token (`TOKEN REJECTED
(401)`) or a missing one on an account platform (where every push would
401 silently) instead of leaving the dashboard mysteriously empty;
whether the cwd workspace's `vx.workspace.ts` declares `cloud()` (a set
`VX_CLOUD_DISTRIBUTE` is flagged **IGNORED** when it doesn't — the env
var is read by the plugin, not by core); and, when distribution is
enabled, the session's remote-agent count from `/v1/agents`.

```
$ vx-cloud status
connection    https://vx.corp.example  (active environment)
token         present
server        ok (corp · vx 0.2.1 · auth: account)
auth probe    ok
workspace     /work/repo · cloud() declared
distribution  explicit (VX_CLOUD_DISTRIBUTE=4)
agent pool    4 remote agents (session 12345-1)
```

Always exits 0 — it is a printout, not a gate. Note that `vx-cloud
connect` already refuses the most common trap up front (a tokenless
connect to an account platform); `status` is for diagnosing an existing
setup.

## `vx-cloud agent` — distributed-execution agent

Attach this machine's checkout to a server's session registry and execute
assigned tasks via scoped, fully CACHED core runs.

```
vx-cloud agent --url <serve-origin>   # (or --coordinator; falls back to
                                      #  VX_CLOUD_URL / VX_SERVICE_URL / the
                                      #  connected environment)
    --token <t>                       # serve bearer (env: VX_CLOUD_TOKEN)
    --capacity <n>                    # max concurrent assignments (default 1)
    --session <s>                     # session key (default: VX_AGENT_SESSION >
                                      #  CI-derived > 'local')
    --idle-timeout <ms>               # self-terminate when idle (default 10 min;
                                      #  0 = never)
    --label <l>                       # capability label (repeatable)
```

Behavior:

- Startup checks: git present, CLEAN worktree (a dirty agent exits 1 before
  poisoning keys), commit + workspace-id capture.
- Injects a native-wire cache client pointed at the server's own `/v1/cache`
  store into every scoped run (`RunOptions.remoteCache`) — the cache IS the
  artifact transport between agents. Sets `VX_CLOUD_AGENT=1` so `cloud()`'s
  telemetry rung declines.
- Registers over `/v1/agents` with
  `agent:hello { protocol, workspaceId, session, commitSha, capacity }`.
  Protocol or commit mismatch → `agent:refused` naming both, exit 1.
- Per `task:assign { taskId }`: a scoped in-process `run()` of the exact
  task id WITH its dep closure — deps restore as warm hits from the shared
  store, the task executes, its artifact uploads before `agent:done`.
- Exits 0 on clean drain or idle timeout EVEN WHEN TASKS FAILED (the
  submitting run owns the aggregate verdict); 1 on refusal, dirty tree, or
  unexpected disconnect.

Enable distribution on the submitting run with `VX_CLOUD_DISTRIBUTE=<n>`
(or `cloud({ distribute: n })`) — the `cloud()` backend then prepares the
graph, submits it to the server (`dist:submit`), self-registers as an
agent, renders the relayed stream, and materializes outputs locally.
Refusal gates (dirty tree, non-remote cache policy, `-- forwardArgs`,
persistent tasks) fall back LOUDLY to a normal local run; an unreachable
server is a hard error. The full workflow — CI recipes, the correctness
contract, and failure modes — is on
[Distributed CI](/vx/cloud/distributed-ci/).

## `vx-cloud dev` — devtools hub

Foreground devtools hub that ingests forwarded NDJSON events from a local
`vx run` and renders them through a connected web client. Needs the
optional `devframe` package.

```
vx-cloud dev                     # bind a kernel-assigned local socket
```

Optional and dev-time only. Production observability is the telemetry-plugin
path: declare `otel()` from `@vzn/vx-otel` in `vx.workspace.ts` and set
`OTEL_EXPORTER_OTLP_ENDPOINT` (the endpoint alone no longer auto-exports),
or push run summaries to a deployed platform via the `cloud()` plugin.
