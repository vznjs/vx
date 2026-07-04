# @vzn/vx-cloud — the orchestrator service image.
#
# Build context is the REPO ROOT (core + cloud share one workspace
# and one lockfile):
#
#   docker build -f packages/cloud/Dockerfile -t vx-cloud .
#
# ONE role: `vx-cloud serve` — a single Bun process serving the embedded
# dashboard UI, the /v1/* analytics API, the /v8/artifacts remote cache, and
# the /mcp endpoint, all over a SQLite ingest store fed by POST /v1/ingest (the
# cloud() plugin pushes to it). vx-cloud reads only its own store — never a
# workspace cache.db — so it can run anywhere. Distributed-execution `agent`s
# are per-CI-job processes, not long-lived containers. See deploy/README.md for
# docker-compose.

# ---------------------------------------------------------------------------
# Build stage — install the workspace, compile bin.ts to a standalone binary.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS build
WORKDIR /app

# Whole workspace: core `src/`, `packages/cloud` (incl. its embedded dashboard
# `packages/cloud/ui`, whose committed `dist/index.html` ui-asset.ts embeds via
# `with { type: 'file' }`), the root package.json + bun.lock + link-self.ts.
COPY . .

# Reproduces the workspace resolution; the root postinstall (scripts/link-self.ts)
# re-creates the node_modules/@vzn/vx -> root symlink so the cloud package's
# bare `import … from '@vzn/vx'` resolves to core's src/index.ts.
RUN bun install --frozen-lockfile

# The dashboard is NOT rebuilt here. packages/cloud/ui/dist/index.html is
# committed and authoritative (whitelisted in .gitignore + .dockerignore);
# ui-asset.ts embeds it at compile time. Skipping `vite build` keeps the image
# lean and the build read-only w.r.t. the repo. (To rebuild the SPA instead,
# run `bun run --filter '@vzn/vx-ui' build` before the compile step.)

# bun build --compile bundles @vzn/vx-cloud + its @vzn/vx workspace dep + the
# embedded SPA into one self-contained binary. This is the load-bearing step.
RUN bun build --compile packages/cloud/src/cli/bin.ts --outfile /out/vx-cloud

# ---------------------------------------------------------------------------
# Runtime stage — just the binary, on the slim Bun base, as a non-root user.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

COPY --from=build /out/vx-cloud /usr/local/bin/vx-cloud

# Persistent home for the SQLite ingest store. Created + owned before dropping
# privileges; mount a volume here in production so pushed runs survive restarts.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

# Run as the unprivileged `bun` user the base image already provides.
USER bun
WORKDIR /home/bun

# serve binds DEFAULT_SERVE_PORT = 4321.
EXPOSE 4321

# /health is pre-auth (no token needed). It works even when the serve binds
# 0.0.0.0 (which includes loopback), so the 127.0.0.1 probe is always valid.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4321/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process: Bun + the SQLite ingest store (at the /data volume) + the
# embedded UI + the /v8 remote cache + /mcp, fed by the cloud() plugin's pushes
# to POST /v1/ingest.
#
# To be reachable from OUTSIDE the container the serve must bind a non-loopback
# host, which REQUIRES a token (an unauthenticated serve on a reachable
# interface would expose task execution). So run it with BOTH set, e.g.:
#   docker run -p 4321:4321 -v vxdata:/data \
#     -e VX_CLOUD_HOST=0.0.0.0 -e VX_CLOUD_TOKEN=<secret> vx-cloud
# (The default 127.0.0.1 bind is intentional — it means a tokenless container
# is only reachable from inside itself.)
ENTRYPOINT ["vx-cloud"]
CMD ["serve", "--ingest-dir", "/data"]
