# Deploying `@vzn/vx-cloud`

Same artifact, three roles — the image ENTRYPOINT is `vx-cloud`; the container
arg picks the role. Run it as one collapsed-local process or a scaled-out
coordinator + worker fleet.

**Layering:** k8s owns pod lifecycle (start/stop/scale); vx owns scheduling
(which ready task each connected worker pulls). vx is not a cluster scheduler —
it rides on top of one.

## The image

Build context is the **repo root** — core (`src/`) and `packages/cloud`
(which now contains its own embedded dashboard at `packages/cloud/ui`) share
one workspace and one lockfile:

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
it at compile time. To rebuild the SPA instead, run
`bun run --filter '@vzn/vx-ui' build` before the compile step.

## Local — one collapsed process

`vx-cloud serve` is coordinator + worker + submission target + dashboard host +
cache + insights in one Bun process (design §8.1). While it runs, every `vx run`
in the workspace delegates to it over a WebSocket.

```sh
# from a source checkout
vx-cloud serve --ui

# or as a container (4321 = DEFAULT_SERVE_PORT)
docker run --rm -p 4321:4321 vx-cloud serve --ui
# API + dashboard at http://localhost:4321
```

> **Snapshot the ingest volume before upgrading.** The `/data` ingest store
> currently rides core vx's cache schema, which is dropped + recreated on a
> schema-version bump (pre-alpha, no migrations) — an upgrade across a bump
> **resets the server's run history** (the serve logs
> `ingest store schema upgraded — run history was reset` when it happens).
> Back up `/data` (or the `--ingest-dir` path) before pulling a new image if
> the history matters to you. An ingest-owned schema with additive migrations
> is on the roadmap.

## Hosted — coordinator + worker fleet

```
┌──────────── namespace: vx-cloud ─────────────────────────────────────┐
│  Service: coordinator   (vx-cloud coordinator)                        │
│   • holds the ready-queue + run state + WS fan-out                    │
│   • /v1/* (metrics), run-submit WS, /health, /version                 │
│  Deployment: workers    (vx-cloud worker --coordinator <svc-dns>)     │
│   • HPA-scaled (CPU [+ optional queue_depth]); stateless, fungible    │
│  Shared CAS             (fs PVC | S3 | R2 — the CASBackend interface) │
│  Insights store         (SQLite PVC | external Postgres)              │
└───────────────────────────────────────────────────────────────────────┘
```

Workers connect to the coordinator's in-cluster Service DNS
(`http://<release>-coordinator:<port>`), send `worker:hello`, pull ready tasks,
run the shell command, upload the artifact, report `worker:done`. On scale-down
the coordinator broadcasts `coord:drain`; a worker finishes its in-flight task,
replies `worker:bye`, and exits — so `worker.terminationGracePeriodSeconds` must
exceed the longest task a draining worker might be mid-flight on (default 120s).

### Install

```sh
# hosted (default values)
helm install vx-cloud packages/cloud/deploy/helm/vx-cloud \
  --namespace vx-cloud --create-namespace \
  --set image.repository=ghcr.io/vznjs/vx-cloud --set image.tag=0.0.0

# collapsed-local in k8s (one serve pod)
helm install vx-cloud packages/cloud/deploy/helm/vx-cloud \
  -f packages/cloud/deploy/helm/vx-cloud/values-local.yaml
```

## values.yaml knobs

| Key                                              | Default              | Meaning                                                                  |
| ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| `mode`                                           | `hosted`             | `hosted` (coordinator + worker) or `local` (one `serve` pod).            |
| `image.repository` / `tag` / `pullPolicy`        | ghcr / appVersion    | The shared image.                                                        |
| `coordinator.replicas`                           | `1`                  | Keep at 1 until the persistent coordinator (Phase 5).                    |
| `coordinator.port`                               | `5180`               | Coordinator bind port.                                                   |
| `coordinator.ingress.enabled` / `host` / `tls`   | off                  | TLS `wss://` ingress for the run-submit WS + metrics.                    |
| `worker.minReplicas` / `maxReplicas`             | `1` / `10`           | HPA bounds.                                                              |
| `worker.capacity`                                | `4`                  | Concurrent tasks per worker pod.                                         |
| `worker.hpa.targetCPUUtilizationPercentage`      | `70`                 | CPU scaling target.                                                      |
| `worker.hpa.queueDepth.enabled`                  | `false`              | Scale on ready-queue depth (needs a custom-metrics adapter).             |
| `worker.terminationGracePeriodSeconds`           | `120`                | Window for the `coord:drain` → `worker:bye` graceful drain.              |
| `cache.backend`                                  | `fs`                 | `fs` (PVC) \| `s3` \| `r2` — a config swap over the `CASBackend` iface.  |
| `cache.fs.size` / `accessMode`                   | `50Gi` / RWX         | Shared artifact PVC (RWX so every worker reads/writes it).               |
| `cache.s3.endpoint` / `bucket` / `region`        | —                    | External object store; creds via `existingSecret` or inline keys.        |
| `insights.store`                                 | `sqlite`             | `sqlite` (PVC) \| `postgres` (external DSN).                             |
| `auth.token` / `auth.existingSecret`             | empty                | Shared token; empty = open (trusted-network only).                       |

## Phasing note

This is design Phase 4 — Docker + Helm skeleton. The coordinator is still
ephemeral-per-run; the persistent multi-run coordinator (`coordinator.replicas`
> 1, leader election) is Phase 5, and blob-CAS input shipping (untrusted /
dirty-local workers) is Phase 6. The `s3`/`r2` cache and `postgres` insights
knobs surface the wiring those phases consume; today's worker assumes a shared
workspace checkout (or the `fs` shared cache).
