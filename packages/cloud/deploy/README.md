# Deploying `@vzn/vx-cloud`

`vx-cloud serve` is the whole service: **one process, one container.** It
serves the embedded dashboard, the `/v1/*` analytics API, the `/v8/artifacts`
remote cache, and the `/mcp` endpoint, all over a SQLite ingest store fed by
`POST /v1/ingest` (the `cloud()` plugin pushes each run's summary to it). It
reads only its own store — never a workspace `cache.db` — so it can run
anywhere, with no access to the machines that produced the runs.

There is **no coordinator/worker fleet and no Helm chart**: the server is a
single process, and distributed-execution `agent`s are per-CI-job processes
(see the [Distributed CI execution](https://vznjs.github.io/vx/guides/distributed-ci/)
guide), not long-lived pods. For Kubernetes, run the same image as a
one-container `Deployment` + `Service` + a `PersistentVolumeClaim` on `/data`
— it needs nothing a plain container doesn't.

## The image

CI publishes a prebuilt image to the GitHub Container Registry on every push
to `main` and every release — the fastest path is to pull it, no clone or
build required:

```sh
docker pull ghcr.io/vznjs/vx-cloud:latest
```

Tags: `latest` (tip of `main`), `X.Y.Z` / `X.Y` (releases), `sha-<short>` (an
exact commit). To build it yourself, the build context is the **repo root** —
core (`src/`) and `packages/cloud` (which carries its own embedded dashboard at
`packages/cloud/ui`) share one workspace and one lockfile:

```sh
docker build -f packages/cloud/Dockerfile -t vx-cloud .
```

Multi-stage: a `oven/bun:1.3` build stage runs `bun install --frozen-lockfile`
(its postinstall re-links `node_modules/@vzn/vx -> <root>` so the cloud
package's bare `import … from '@vzn/vx'` resolves) and
`bun build --compile packages/cloud/src/cli/bin.ts` into one self-contained
binary; the `oven/bun:1.3-slim` runtime stage carries only that binary, runs as
the non-root `bun` user, and `HEALTHCHECK`s `/health`.

The bundled dashboard SPA is **not** rebuilt in the image — the committed
`packages/cloud/ui/dist/index.html` is authoritative and `ui-asset.ts` embeds
it at compile time. **You never build the SPA to deploy** — a released binary
or image already carries it. (Only a contributor hacking on the dashboard runs
`bun run --filter '@vzn/vx-ui' build`.)

## Auth: a reachable serve requires a token

The serve binds `127.0.0.1` by default, so a tokenless container is only
reachable from inside itself. To accept connections from outside the container
it must bind a non-loopback host (`VX_CLOUD_HOST=0.0.0.0`), and a non-loopback
bind **requires a token** — an unauthenticated serve on a reachable interface
would expose task execution. So a real deployment sets **both**
`VX_CLOUD_HOST=0.0.0.0` and `VX_CLOUD_TOKEN=<secret>`.

## `docker run`

```sh
docker run -p 4321:4321 -v vxdata:/data \
  -e VX_CLOUD_HOST=0.0.0.0 \
  -e VX_CLOUD_TOKEN="$(openssl rand -hex 32)" \
  vx-cloud
# dashboard + API at http://localhost:4321  (Authorization: Bearer <token>)
```

The `/data` volume holds the SQLite ingest store **and** the `/v8` artifact
store — mount it on a volume so both survive restarts.

## `docker compose`

[`docker-compose.yml`](./docker-compose.yml) is the same thing, declarative:

```sh
VX_CLOUD_TOKEN=$(openssl rand -hex 32) \
  docker compose -f packages/cloud/deploy/docker-compose.yml up
```

It also builds from source if you haven't pushed an image (`docker compose
build`). Optional env it documents inline: `VX_CLOUD_PR_TOKEN` (the fork-PR
read-only cache token) and `VX_CLOUD_ALLOW_ORIGIN` (a hosted dashboard on a
different origin than the serve).

## Connecting a workspace

From any workspace, point runs at the deployed serve so its dashboard fills and
its remote cache is used:

```sh
vx-cloud connect https://vx.example.com --name team --token <secret>
# every `vx run` now pushes its summary there; if the serve advertises the
# artifact store (/v1/meta artifacts:true), the remote cache auto-wires.
```

Or wire it explicitly with env vars (`VX_CLOUD_INGEST_URL`,
`VX_REMOTE_CACHE_URL` + `VX_REMOTE_CACHE_TOKEN`) — see the
[Self-host](https://vznjs.github.io/vx/guides/self-hosting/) and
[Remote caching](https://vznjs.github.io/vx/guides/remote-caching/) guides.

## TLS

The serve terminates plain HTTP/WS. Front it with a reverse proxy (nginx,
Caddy, Traefik) for TLS. It has native token auth, so proxy-level basic-auth is
optional. A Caddy example:

```
vx.example.com {
  reverse_proxy localhost:4321
}
```

## Upgrading — snapshot `/data` first

> The `/data` ingest store currently rides core vx's cache schema, which is
> dropped + recreated on a schema-version bump (pre-alpha, no migrations) — an
> upgrade across a bump **resets the server's run history** (the serve logs
> `ingest store schema upgraded — run history was reset` when it happens). Back
> up `/data` (or the `--ingest-dir` path) before pulling a new image if the
> history matters to you. The `/v8` artifacts under `/data/artifacts` are plain
> files and are unaffected. An ingest-owned schema with additive migrations is
> on the roadmap.
