# @vzn/vx-ui

The vx-cloud dashboard — a Solid SPA served by the `vx-cloud server`
platform. It builds to a **single self-contained `dist/index.html`**
(JS + CSS inlined; see `vite.config.ts`); the server binary embeds that
one file via `with { type: 'file' }`, so the dashboard ships inside
`vx-cloud` with nothing else on disk. `dist/` is a build artifact
(gitignored) — every consumer (npm package, Docker image, local binary
build) runs the vite build first.

## Develop

You need a running platform to develop against — the compose stack is
the one-command way (Postgres + MinIO + the server):

```bash
# 1. Boot the platform (first run: register the instance admin in the UI)
VX_CLOUD_SECRET=$(openssl rand -hex 32) docker compose \
  -f packages/cloud/deploy/docker-compose.yml up
# — or run the server from source against your own Postgres/S3 env:
#   bun packages/cloud/src/cli/bin.ts server

# 2. Start the UI dev server (from packages/cloud/ui)
bun run --filter @vzn/vx-ui dev      # vite on :5290
```

The dev server **proxies** `/v1`, `/health`, `/mcp`, `/events` and
`/stream` to `http://localhost:4321` (override with
`VX_CLOUD_DEV_PROXY=<origin>`), so every request is same-origin: the
HttpOnly session cookie and the CSRF header behave exactly like the
production build the platform hosts. Log in at `http://localhost:5290`
with the same account you registered on the platform.

`VITE_DEFAULT_ORIGIN` can still pin an explicit API origin (it wins
over the page origin), but with the proxy you shouldn't need it — a
cross-origin API target breaks the credentialed session flow.

## Build

```bash
bun run --filter @vzn/vx-ui build    # produce the single-file dist/index.html
# or, via vx (what the binary build uses):
vx run build.ui
```

## What's inside

- **Runs** — the landing: history table, CI-health strip, filters.
- **Workspace / Projects / Tasks** — catalog∪rollup entity pages with
  per-task config, trends, recommendations and debug links.
- **Cache / Artifacts** — entries, artifact provenance, downloads.
- **Insights** — trends, movers, flaky/regression/hermeticity cards.
- **Admin** — members, invites, tokens, workspaces, settings (RBAC
  reflected; the server is the enforcer).

Every read is an HTTP call to the platform's `/v1/*` analytics routes
(Postgres-backed) under the session cookie; the SPA holds no secrets
and no direct storage access.
