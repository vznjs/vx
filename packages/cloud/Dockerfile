# @vzn/vx-cloud — the orchestrator service image.
#
# Build context is the REPO ROOT (core + cloud share one workspace
# and one lockfile):
#
#   docker build -f packages/cloud/Dockerfile -t vx-cloud .
#
# Same artifact, multiple roles — the ENTRYPOINT is `vx-cloud`, the CMD picks
# the role. The DEFAULT CMD is the dashboard: one Bun process serving the UI +
# the /v1/* API over a SQLite ingest store fed by POST /v1/ingest (the cloud()
# plugin pushes to it). vx-cloud reads only its own store — never a workspace
# cache.db — so it can run anywhere. Other roles: coordinator, worker. See
# deploy/README.md.

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

# serve (hosted dashboard / collapsed-local) + coordinator bind here by default:
#   serve       DEFAULT_SERVE_PORT = 4321
#   coordinator default --port     = 5180
EXPOSE 4321 5180

# /health is served by both `serve` and `coordinator`. Default-CMD `serve`
# uses 4321; override the URL when the role/port differs (the Helm chart sets
# its own probes per role).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4321/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default role: the dashboard — Bun + SQLite ingest store (at the /data volume)
# + the embedded UI, all in one process, fed by the cloud() plugin's pushes to
# POST /v1/ingest. Override CMD for coordinator or worker.
ENTRYPOINT ["vx-cloud"]
CMD ["serve", "--ingest-dir", "/data"]
