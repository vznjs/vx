# @vzn/vx-cloud — the self-hosted CI platform image.
#
# Build context is the REPO ROOT (core + cloud share one workspace
# and one lockfile):
#
#   docker build -f packages/cloud/Dockerfile -t vx-cloud .
#
# ONE role: `vx-cloud server` — a single Bun process serving the embedded
# dashboard UI, the account/RBAC + admin API (`/v1/auth/*`, `/v1/admin/*`), the
# analytics API (`/v1/*`, Postgres-backed), the vx-native remote cache
# (`/v1/cache/:hash`, S3-backed), the distribution WS channels, and `/mcp`. The
# platform is STATELESS on local disk: all history lives in Postgres and all
# artifact bytes in an S3-compatible bucket. It REFUSES to boot without full
# config (DATABASE_URL + VX_CLOUD_SECRET + VX_CLOUD_BASE_URL + the four
# VX_CLOUD_S3_* vars). There is no `serve` verb and no companion mode — a
# workspace CONNECTS to a deployed platform. See deploy/docker-compose.yml.

# ---------------------------------------------------------------------------
# Build stage — install the workspace, compile bin.ts to a standalone binary.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS build
WORKDIR /app

# Whole workspace: core `src/`, `packages/cloud` (incl. its dashboard source
# `packages/cloud/ui`), the root package.json + bun.lock + link-self.ts. The
# SPA dist is a build artifact (not in the repo) — it's built below.
COPY . .

# Reproduces the workspace resolution; the root postinstall (scripts/link-self.ts)
# re-creates the node_modules/@vzn/vx -> root symlink so the cloud package's
# bare `import … from '@vzn/vx'` resolves to core's src/index.ts.
RUN bun install --frozen-lockfile

# Build the dashboard SPA to packages/cloud/ui/dist/index.html — ui-asset.ts
# embeds it into the binary at compile time via `with { type: 'file' }`, so it
# MUST exist before the compile resolves that import.
RUN cd packages/cloud/ui && bun run build

# bun build --compile bundles @vzn/vx-cloud + its @vzn/vx workspace dep + the
# just-built SPA into one self-contained binary. This is the load-bearing step.
RUN bun build --compile packages/cloud/src/cli/bin.ts --outfile /out/vx-cloud

# ---------------------------------------------------------------------------
# Runtime stage — just the binary, on the slim Bun base, as a non-root user.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

COPY --from=build /out/vx-cloud /usr/local/bin/vx-cloud

# Run as the unprivileged `bun` user the base image already provides. The
# platform writes NOTHING to local disk (Postgres + S3 hold all state), so
# there is no volume — the container is stateless and horizontally scalable.
USER bun
WORKDIR /home/bun

# server binds 0.0.0.0 on VX_CLOUD_PORT (default 4321).
EXPOSE 4321

# /health is pre-auth (no account/token needed). The scheme follows the
# in-process-TLS config: with VX_CLOUD_TLS_CERT set the port serves HTTPS only,
# so a plain-http probe would fail the TLS handshake and mark a healthy
# container unhealthy forever (self-signed/internal certs are fine — the probe
# checks liveness, not the trust chain).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD bun -e "const s=process.env.VX_CLOUD_TLS_CERT?'https':'http';fetch(s+'://127.0.0.1:'+(process.env.VX_CLOUD_PORT||'4321')+'/health',{tls:{rejectUnauthorized:false}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The platform boots only with full config. It reaches Postgres, applies
# migrations, probes the S3 bucket, then binds 0.0.0.0. The FIRST account
# registered at VX_CLOUD_BASE_URL becomes the instance admin; signup then
# closes (invite-only). Required env (boot refuses listing every missing one):
#   DATABASE_URL              postgres://user:pass@host:5432/db
#   VX_CLOUD_SECRET           >= 32 chars (session/token HMAC) — openssl rand -hex 32
#   VX_CLOUD_BASE_URL         the public origin, e.g. https://vx.acme.dev
#   VX_CLOUD_S3_ENDPOINT      S3-compatible endpoint (R2/MinIO/AWS)
#   VX_CLOUD_S3_BUCKET        the artifact bucket (must already exist)
#   VX_CLOUD_S3_ACCESS_KEY_ID / VX_CLOUD_S3_SECRET_ACCESS_KEY
# Optional in-process TLS: mount PEM files into the container (readable by the
# `bun` user) and set VX_CLOUD_TLS_CERT + VX_CLOUD_TLS_KEY (stable HTTPS/1.1);
# VX_CLOUD_HTTP3=1 additionally enables experimental HTTP/3 — publish the port
# as UDP too. Prefer HTTP/2 at an edge proxy for stable multiplexing.
# See deploy/docker-compose.yml for a full stack (app + postgres + minio).
ENTRYPOINT ["vx-cloud"]
CMD ["server"]
