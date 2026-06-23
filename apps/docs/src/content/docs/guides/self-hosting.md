---
title: Self-host vx serve
description: Deploy vx serve in Docker (or any container runtime). One process, one stack. Powers local CLI, hosted SPA, team analytics.
---

`vx serve` is the unified backend. The same binary that powers
`vx run` delegation locally also runs in Docker as a team-shared
endpoint. There is no separate cloud stack — `vx serve` is the
cloud.

## What it gives you

| Surface | Path |
| --- | --- |
| Health | `GET /health` |
| Capabilities | `GET /version` |
| Insights API (read-only) | `GET /v1/runs`, `/v1/invocations`, `/v1/runs/:id`, `/v1/cache/stats`, `/v1/history`, `/v1/explain/:taskId`, `/v1/why/:runId/:taskId` |
| Event stream | `GET /v1/events` (SSE), `GET /stream` (NDJSON) |
| Run submission | `WS /` (JSON envelopes) |

All HTTP responses ship `Access-Control-Allow-Origin: *` so a
hosted SPA can read from your machine, and a self-hosted SPA can
read from the hosted endpoint.

## Docker deploy

A minimal Dockerfile:

```dockerfile
FROM oven/bun:1
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
EXPOSE 4321
CMD ["bun", "src/bin.ts", "serve", "--port", "4321"]
```

```sh
docker build -t vx-serve .
docker run --rm -p 4321:4321 vx-serve
```

Persisting the cache across container restarts means mounting
`<workspaceRoot>/.vx/`:

```sh
docker run --rm \
  -p 4321:4321 \
  -v $(pwd)/.vx:/workspace/.vx \
  vx-serve
```

## docker-compose

```yaml
services:
  vx-serve:
    image: vx-serve:latest
    ports:
      - "4321:4321"
    volumes:
      - ./.vx:/workspace/.vx
      - ./:/workspace:ro
    environment:
      VX_REMOTE_CACHE_URL: https://your-cache.example.com
      VX_REMOTE_CACHE_TOKEN: ${VX_REMOTE_CACHE_TOKEN}
```

## Auth + TLS

`vx serve` does not ship auth or TLS — by design, it's a Bun.serve
process that binds to a port. Front it with a reverse proxy
(nginx, Caddy, Traefik) for TLS termination and any auth scheme
your environment uses.

A Caddy example:

```
vx.example.com {
  reverse_proxy localhost:4321
  basicauth {
    team {$BCRYPT_HASH}
  }
}
```

## Dashboard

`vx serve --ui` serves the dashboard at `/` directly from the binary
(it's embedded — no asset directory to deploy). For a hosted
deployment behind a proxy, that's all you need.

If you'd rather host the dashboard separately, build the single-file
bundle and drop it on any static host. The connection picker means
the same bundle works against any reachable `vx serve`:

```sh
cd apps/ui
bun install
bun run build
# Deploy the single dist/index.html anywhere (S3 + CloudFront, Vercel,
# GitHub Pages, your own nginx).
```

## Browser → localhost gotcha

The Secure Context exception in WHATWG lets HTTPS pages call
`http://localhost:*`. So a hosted `https://dash.example.com`
can read from `http://localhost:4321` without breaking the mixed-
content rule — that's intentional, and what the connection picker
exploits.

## Why one stack

Previous versions of vx shipped a separate Cloudflare Workers
project (`apps/cloud/`) for hosted use, with a different SQL
backend (D1 vs bun:sqlite), different runtime, different deploy
story. We unified on `vx serve`:

- Bun is fine on any host (Docker is the lingua franca).
- One SQL backend (bun:sqlite) is one bug surface, one schema
  migration story, one set of queries.
- The hosted SPA sees the same `/v1/*` shape locally or against a
  multi-tenant deployment — no shimming.

See also: [`dashboard`](/vx/guides/dashboard/),
[`wire protocol`](/vx/guides/wire-protocol/).
