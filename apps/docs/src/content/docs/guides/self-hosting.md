---
title: Self-host vx-cloud
description: Deploy the vx-cloud service in Docker. Token-authenticated, standalone SQLite ingest store, embedded dashboard, and a serve-hosted Turborepo-wire remote cache — no access to your workspaces required.
---

The team-shared backend is a **separate package and binary**: `vx-cloud`
(`@vzn/vx-cloud`), distinct from core `vx` (`@vzn/vx`). Install
`@vzn/vx-cloud` to run the service; the command is `vx-cloud serve`.

`vx-cloud serve` is one Bun process that carries a SQLite ingest store,
the `/v1/*` analytics API, the embedded dashboard, a Turborepo-wire
remote cache, an MCP endpoint for AI agents, and the WebSocket channels
for delegated + distributed runs. It reads **only its own store** — it
never opens a workspace `cache.db` — so you can deploy it on a box that
has no access to the machines that produce your runs.

## How it gets its data

`vx-cloud` is independent of core `vx`. It does not crawl your cache; it
is **pushed** to. Every `vx run` that has the `cloud()` plugin configured
(or a connected environment) posts a run summary to `POST /v1/ingest`,
and the serve persists it into its own per-workspace SQLite store
(default `<root>/.vx/cloud-ingest`, override with `--ingest-dir`). The
dashboard reads from that store — never from a developer's private
`cache.db`.

## HTTP + WS surface

| Path | Purpose | Auth |
| --- | --- | --- |
| `GET /health` | Liveness probe | pre-auth |
| `GET /v1/meta` | Identity + capabilities (`artifacts`, `trustTiers`, workspace count) | pre-auth |
| `GET /v1/*` | Analytics reads (`/v1/runs`, `/v1/invocations`, `/v1/cache/stats`, `/v1/why/:runId/:taskId`, …) | token |
| `POST /v1/ingest` | The push endpoint — where run summaries land | token |
| `GET/HEAD/PUT /v8/artifacts/:hash` | Turborepo remote-cache wire | token |
| `POST /mcp` | MCP server (JSON-RPC 2.0) for AI agents | token |
| `GET /events`, `GET /v1/events` | SSE event stream | token |
| `GET /stream` | NDJSON event stream | token |
| `WS /` | Delegated run submission | token |
| `WS /v1/agents` | Distribution agents | token |

`/v1/meta` is pre-auth by design: it carries no secrets and no workspace
path, so a client can read the server's identity and capabilities before
proving a token. A serve that hosts multiple workspaces scopes the
analytics routes with `?ws=<id>`; the token-gated `GET /v1/workspaces`
lists them.

## Auth and binding

The security posture is loopback-first:

- **Loopback by default.** `vx-cloud serve` binds `127.0.0.1`. Override
  with `--host <h>` or `VX_CLOUD_HOST`.
- **A non-loopback bind requires a token.** Binding `0.0.0.0` (or any
  reachable interface) **without** a token is refused at startup — an
  open serve on the network would expose arbitrary task execution over
  the run/agent WebSocket channels.
- **`--token <t>` / `VX_CLOUD_TOKEN`** sets the shared bearer. Every
  request except `/health` and `/v1/meta` then needs
  `Authorization: Bearer <t>` (constant-time compared). Browser
  transports that can't set headers (`EventSource`, the WS upgrade) may
  pass `?token=<t>` in the query instead.
- **Cross-origin browser handshakes are refused** unless you allow-list
  them with `--allow-origin <o>` (repeatable) or `VX_CLOUD_ALLOW_ORIGIN`
  (comma-separated). CLI clients (no `Origin` header) and same-origin
  requests always pass; this is the CSWSH / drive-by-RCE defense.
- **A unix socket** (`--socket [path]` / `VX_CLOUD_SOCKET`) is a second
  listener. Its `0600` file permissions **are** the auth — socket
  requests bypass the token gate, since only your user can open the
  socket.

```sh
# hosted: reachable interface, so a token is mandatory
vx-cloud serve --host 0.0.0.0 --token "$(openssl rand -hex 32)"

# a hosted dashboard on a different origin needs to be allow-listed
vx-cloud serve --host 0.0.0.0 --token "$TOKEN" \
  --allow-origin https://dash.example.com
```

### Fork-PR trust scopes

The serve-hosted artifact store is partitioned `<bucket>/<tier>`, and the
tier is **derived from the token on the server** — never claimed by the
client. A holder of the main `--token` is *trusted*: it reads and writes
the `trusted/` scope. A holder of `--pr-token` / `VX_CLOUD_PR_TOKEN` is
*untrusted*: it reads trusted + untrusted but writes **only** untrusted,
so a fork-PR CI job can warm off `main`'s cache without being able to
poison it. Artifacts are immutable (re-PUT of an existing hash is
rejected). See the [cache-trust-scopes design
note](/vx/design/cache-trust-scopes-2026-07/) and the [security
review](/vx/design/security-review-2026-07/).

## Run it in Docker

Every push to `main` and every release publishes a prebuilt image to the
GitHub Container Registry — you don't need to clone or build anything:

```sh
docker pull ghcr.io/vznjs/vx-cloud:latest
```

Tags: `latest` (tip of `main`), `X.Y.Z` / `X.Y` (releases), and
`sha-<short>` (an exact commit). To build it yourself instead, use the
repo root as the build context (core and cloud share one workspace and one
lockfile):

```sh
docker build -f packages/cloud/Dockerfile -t vx-cloud .
```

The image `ENTRYPOINT` is `vx-cloud`; the default `CMD` is
`serve --ingest-dir /data`, it `EXPOSE`s `4321`, runs as a non-root user,
and carries the dashboard embedded in the compiled binary.

Inside a container the serve must bind `0.0.0.0` to be reachable through
Docker's port mapping — and a non-loopback bind requires a token. So a
Docker deploy **must** set both `VX_CLOUD_HOST=0.0.0.0` and
`VX_CLOUD_TOKEN`:

```sh
docker run --rm \
  -p 4321:4321 \
  -v vxdata:/data \
  -e VX_CLOUD_HOST=0.0.0.0 \
  -e VX_CLOUD_TOKEN=your-secret-token \
  ghcr.io/vznjs/vx-cloud:latest
# API + dashboard at http://localhost:4321
```

Persist `/data` on a volume — it holds the SQLite ingest store **and** the
artifact store, so mounting it keeps pushed run history and cached
artifacts across container restarts. (The `HEALTHCHECK` probes
`127.0.0.1:4321/health`, which still passes: binding `0.0.0.0` includes
loopback.)

> **Snapshot `/data` before upgrading.** The ingest store currently rides
> core vx's cache schema, which is dropped and recreated on a
> schema-version bump (pre-alpha, no migrations) — an upgrade across a
> bump resets the server's run history. Back up the volume if the history
> matters to you.

### docker-compose

See [`packages/cloud/deploy/README.md`](https://github.com/vznjs/vx/blob/main/packages/cloud/deploy/README.md)
for the full deploy guide. A minimal compose service mirrors the
`docker run` above:

```yaml
services:
  vx-cloud:
    image: ghcr.io/vznjs/vx-cloud:latest
    ports:
      - "4321:4321"
    environment:
      VX_CLOUD_HOST: 0.0.0.0
      VX_CLOUD_TOKEN: ${VX_CLOUD_TOKEN}
    volumes:
      - vxdata:/data

volumes:
  vxdata:
```

## TLS / reverse proxy

Front the serve with nginx, Caddy, or Traefik for TLS termination. The
serve now has native token auth, so proxy-level basicauth is optional:

```caddy
vx.example.com {
  reverse_proxy localhost:4321
}
```

When you terminate TLS at the proxy, keep the serve bound to loopback on
the host and let the proxy be the only thing that reaches it — or, if the
serve runs in its own container, keep its token set (the proxy still needs
to forward the `Authorization` header or the browser's `?token=`).

## Serve-hosted remote cache

Because the serve implements the Turborepo `/v8/artifacts/` wire, it
doubles as a remote cache with no separate cache server. Point core's
remote-cache variables at it:

```bash
export VX_REMOTE_CACHE_URL=https://vx.example.com
export VX_REMOTE_CACHE_TOKEN=your-secret-token
```

See [Remote caching](/vx/guides/remote-caching/) for the full variable
set (team id, signing, timeouts).

## Connect a workspace

Rather than setting environment variables by hand, `vx-cloud connect`
persists a named, per-user environment. Every `vx run` then pushes its
summary there, and when the serve advertises `artifacts:true` (it does),
the remote cache auto-wires:

```sh
vx-cloud connect https://vx.example.com --name team --token your-secret-token
```

Flags: `--delegate` opts the environment into run delegation; `--no-use`
records it without activating it. Manage environments with
`vx-cloud env ls | use <name> | rm <name>`, and clear the active one with
`vx-cloud disconnect`. Tokens are stored `0600` and never printed.

## Dashboard

The dashboard is **embedded in the compiled `vx-cloud` binary and the
Docker image** — a released artifact already carries it. Nothing to build,
nothing to deploy separately. `vx-cloud serve --ui` serves it at `/`:

```sh
docker run --rm -p 4321:4321 \
  -v vxdata:/data \
  -e VX_CLOUD_HOST=0.0.0.0 \
  -e VX_CLOUD_TOKEN=your-secret-token \
  vx-cloud serve --ui --ingest-dir /data
```

(Only a contributor hacking on the dashboard SPA itself ever runs its
build; deploying the service never does.)

See also: [`Dashboard`](/vx/guides/dashboard/),
[`Remote caching`](/vx/guides/remote-caching/),
[`Distributed CI execution`](/vx/guides/distributed-ci/),
[`vx mcp — AI agents`](/vx/guides/mcp/),
[`Wire protocol`](/vx/guides/wire-protocol/).
