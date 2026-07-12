# Deploying `@vzn/vx-cloud`

`vx-cloud` is a **self-hosted CI platform** — accounts, organizations,
RBAC, and API tokens, with **Postgres** as the system of record and an
**S3-compatible bucket** for artifacts. The single verb is
**`vx-cloud server`**: one stateless process that serves the embedded
dashboard, the account/RBAC + Admin API (`/v1/auth/*`, `/v1/admin/*`), the
analytics API (`/v1/*`), the vx-native remote cache (`/v1/cache/:hash`),
the distribution WebSocket channels (`/v1/agents`), and MCP (`/mcp`).

It is **not** a companion process — a workspace *connects* to a deployed
platform; nothing auto-starts next to `vx`. There is no `serve` verb, no
tokenless mode, and no local-disk state: the app writes nothing to disk, so
you can scale it out behind a load balancer.

## The image

CI publishes a prebuilt image to the GitHub Container Registry on every
push to `main` and every release:

```sh
docker pull ghcr.io/vznjs/vx-cloud:latest
```

Tags: `latest` (tip of `main`), `X.Y.Z` / `X.Y` (releases), `sha-<short>`
(an exact commit). To build it yourself, the build context is the **repo
root** — core (`src/`) and `packages/cloud` (with its embedded dashboard at
`packages/cloud/ui`) share one workspace and one lockfile:

```sh
docker build -f packages/cloud/Dockerfile -t vx-cloud .
```

The image `ENTRYPOINT` is `vx-cloud`, the default `CMD` is `server`, it
`EXPOSE`s `4321`, runs as a non-root user, and `HEALTHCHECK`s `/health`.

## `docker compose up`

[`docker-compose.yml`](./docker-compose.yml) is the full stack: the app,
Postgres (system of record), and MinIO (an S3-compatible bucket for local
evaluation), plus a one-shot job that creates the bucket the server's boot
probe expects.

```sh
VX_CLOUD_SECRET=$(openssl rand -hex 32) \
  docker compose -f packages/cloud/deploy/docker-compose.yml up
```

On boot the server reaches Postgres, applies migrations (advisory-locked,
so concurrent boots serialize), probes the S3 bucket (fail loud — never a
silent local fallback), then binds `0.0.0.0:4321`. The compose file also
builds from source if you haven't pulled an image (`docker compose build`).

Then open `http://localhost:4321` and **register** — the **first account
becomes the instance admin**, after which signup closes (invite-only). From
the **Admin** area, create an organization and a workspace, invite members
(roles `owner`/`admin`/`member`/`viewer`), and mint API tokens (`vxc_`,
`trusted`/`untrusted` tier, optionally workspace-scoped). Point your CI at a
minted token — see the
[Distributed CI](https://vznjs.github.io/vx/guides/distributed-ci/) and
[Self-hosting](https://vznjs.github.io/vx/guides/self-hosting/) guides.

## Required configuration

The platform **refuses to boot** without full config, listing every
missing/invalid var at once:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` |
| `VX_CLOUD_SECRET` | Session + API-token HMAC secret (**≥ 32 chars**) |
| `VX_CLOUD_BASE_URL` | The public origin; `https://` flips cookies to Secure |
| `VX_CLOUD_S3_ENDPOINT` | S3-compatible endpoint (R2 / AWS S3 / MinIO) |
| `VX_CLOUD_S3_BUCKET` | Artifact bucket (must already exist) |
| `VX_CLOUD_S3_ACCESS_KEY_ID` / `VX_CLOUD_S3_SECRET_ACCESS_KEY` | S3 credentials |

Optional: `VX_CLOUD_S3_REGION` (default `auto`), `VX_CLOUD_S3_PREFIX`,
`VX_CLOUD_S3_PRESIGN_TTL` (default `300`), `VX_CLOUD_PORT` (default `4321`),
`VX_CLOUD_RETENTION_DAYS` (default `180`), `VX_CLOUD_OPEN_SIGNUP`,
`VX_CLOUD_OPEN_ORG_CREATE`.

## Production

- **External object storage.** Delete the `minio` / `createbucket` services
  and point `VX_CLOUD_S3_*` at managed storage (Cloudflare R2, AWS S3, …).
  The bucket must be reachable from wherever `vx run` executes — cache GETs
  redirect the client to a pre-signed bucket URL.
- **TLS + multiplexing.** Front the app with a TLS-terminating proxy for
  stable HTTP/2, or give it a cert directly (`VX_CLOUD_TLS_CERT` +
  `VX_CLOUD_TLS_KEY`) for in-process HTTPS/1.1. Set `VX_CLOUD_BASE_URL` to the
  `https://` origin so session cookies are `Secure`. See **HTTP/2 & HTTP/3
  multiplexing** below.
- **Scale out.** The app is stateless (Postgres + S3 hold all state) — run
  several replicas behind the load balancer; `/health` is the pre-auth
  liveness probe. There is no volume to attach to the app container.

For Kubernetes, run the same image as a `Deployment` + `Service` (with
`Ingress` for TLS) — it needs nothing a plain container doesn't, since it
keeps no local state.

## HTTP/2 & HTTP/3 multiplexing

With HTTP/2 or HTTP/3 a client multiplexes many **concurrent requests over
one connection**, with no per-request TCP + TLS handshake — so a fresh CI
runner priming a large graph pays one handshake, not hundreds. It compounds
with the **batch cache-existence probe** (`POST /v1/cache/batch`, which
already turns N per-hash `HEAD`s into one request): fewer requests, and the
ones that remain share a connection.

`Bun.serve` has **no HTTP/2 server** (HTTP/1.1 + experimental HTTP/3 only),
so the stable, recommended way to multiplex is **HTTP/2 at an edge proxy**.
To keep certs out of the app (a shared LB, a CDN, or older clients),
terminate the modern transports at the proxy and let the app speak plain
HTTP/1.1 to it — the universal production pattern. The compose stack ships a
ready **[Caddy](./Caddyfile) edge** behind an opt-in profile — Caddy does
h1/h2/h3 with one directive and auto-provisions TLS:

```sh
VX_CLOUD_SECRET=$(openssl rand -hex 32) VX_CLOUD_BASE_URL=https://localhost \
  docker compose -f packages/cloud/deploy/docker-compose.yml --profile edge up
# open https://localhost — H3 is advertised via Alt-Svc; UDP 443 is published
```

For a real deployment set `VX_CLOUD_DOMAIN=ci.example.com`, drop the
`tls internal` line from the `Caddyfile` (Caddy then gets a Let's Encrypt
cert over ACME), and set `VX_CLOUD_BASE_URL=https://ci.example.com`. Any
h2/h3-capable proxy works the same way — nginx, Cloudflare, or an L7 load
balancer; the app needs no change because it speaks plain HTTP/1.1 to the
proxy over the internal network. WebSocket (agent/dist) and SSE/NDJSON
streams bridge transparently through the proxy. (Don't run in-process TLS
and an edge proxy at once — pick one TLS terminator.)

**Experimental native HTTP/3.** Instead of a proxy, the app can terminate
TLS itself (`VX_CLOUD_TLS_CERT` + `VX_CLOUD_TLS_KEY`, both-or-neither) for
in-process HTTPS/1.1, and — on **Bun ≥ 1.3.14** — opt into experimental
native HTTP/3 with `VX_CLOUD_HTTP3=1`. HTTP/1.1 responses then carry
`Alt-Svc: h3=…` for QUIC auto-upgrade on the same port. Note this compose
file does NOT wire in-process TLS (its `environment:` block doesn't pass the
TLS vars, no cert volume is mounted, and the app port isn't published as
UDP) — the edge profile is the compose-native path. In-process TLS/H3 fits
bare metal or a plain `docker run` with the PEMs volume-mounted and, for H3,
the port published as UDP too. Because HTTP/3 in Bun is experimental, prefer
HTTP/2 at an edge proxy for production.

## Connecting a workspace

From any workspace, connect to the deployed platform:

```sh
vx-cloud connect https://vx.example.com --name team --token vxc_...
# every `vx run` now shares the remote cache and feeds the dashboard
```

Or wire it with env vars (`VX_CLOUD_URL` + `VX_CLOUD_TOKEN`). See the
[Self-hosting](https://vznjs.github.io/vx/guides/self-hosting/) and
[Remote caching](https://vznjs.github.io/vx/guides/remote-caching/) guides.
