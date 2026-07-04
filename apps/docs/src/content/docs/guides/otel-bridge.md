---
title: OpenTelemetry traces & metrics
description: Export every vx run as OTLP traces + metrics with the @vzn/vx-otel plugin. Declare otel() in vx.workspace.ts; it speaks OTLP/HTTP JSON directly with no OpenTelemetry SDK dependency.
---

`@vzn/vx-otel` turns every `vx run` into **OTLP traces + metrics** —
one trace per run, one span per task, plus run/task counters. It speaks
the OTLP/HTTP JSON wire protocol **directly**, so there's no
OpenTelemetry SDK dependency and nothing to keep version-matched.

It's a plugin, built on vx's observe-only [`telemetry`
capability](/vx/guides/plugins/): it can never change, slow, or fail a
run.

## Quick start

```sh
# 1. Add the plugin
bun add @vzn/vx-otel

# 2. Point at your collector (standard OTel env vars)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=vx
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel()],
})
```

```sh
# 3. Run anything
vx run lint
```

`otel()` is **zero-config**: with no `OTEL_EXPORTER_OTLP_ENDPOINT` set it
**declines** and exports nothing, so it's safe to leave declared in every
environment (local, CI, prod). No peer deps to install — the OTLP payload
is built and POSTed by the plugin itself.

## Configuration

Every knob has a standard-OTel env-var fallback; explicit options win.

| Option           | Env var                               | Default                    |
| ---------------- | ------------------------------------- | -------------------------- |
| `endpoint`       | `OTEL_EXPORTER_OTLP_ENDPOINT`         | — (declines if unset)      |
| `tracesEndpoint` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | `<endpoint>/v1/traces`     |
| `metricsEndpoint`| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `<endpoint>/v1/metrics`    |
| `serviceName`    | `OTEL_SERVICE_NAME`                   | `vx`                       |
| `headers`        | `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,…`)| `{}`                       |
| `metrics`        | —                                     | `true`                     |
| `timeoutMs`      | —                                     | `15000`                    |

```ts
otel({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-monorepo',
  headers: { authorization: 'Bearer …' },
  metrics: true,
})
```

## What lands in your backend

**A trace per run**, using the OTel CI/CD + VCS semantic conventions so
it maps cleanly onto Grafana / Tempo / Honeycomb / Datadog / Jaeger:

- a root **`vx.run`** span — `cicd.pipeline.run.id`,
  `vcs.ref.head.revision`, `vcs.ref.head.name`, the CI provider,
  host/os/arch, vx version, and each `--tag k=v` as `vx.tag.<k>`;
- a child **`vx.task`** span per task — `cicd.pipeline.task.name`,
  `cicd.pipeline.task.run.result`, `vx.cache.source`
  (`miss`/`local`/`remote`), `vx.task.hash`, duration, CPU ms, peak RSS.
  A failed task sets the span status to `ERROR`.

**Metrics per run** (when `metrics` is on): `vx.tasks.total`,
`vx.tasks.failed`, `vx.tasks.cache_hits{source=local|remote}`, and the
`vx.run.duration_ms` gauge.

## Backend pointers

The exporter speaks OTLP/HTTP — every major backend accepts it. Point
`OTEL_EXPORTER_OTLP_ENDPOINT` at the collector and pass auth via
`OTEL_EXPORTER_OTLP_HEADERS`:

```sh
# Grafana Cloud / Tempo
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64-creds>"

# Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<api-key>"

# Local collector (Datadog Agent, Jaeger all-in-one, otelcol, …)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

`OTEL_EXPORTER_OTLP_HEADERS` takes a comma-separated `key=val,key2=val2`
list; anything you pass in the `headers` option is merged over it.

## What this gives you

- **Per-task percentiles.** Aggregate `vx.task` span durations by
  `cicd.pipeline.task.name` for p50/p99 across every run.
- **Regression alerts.** Alert on "p99 of `lint` exceeds baseline by 3×"
  and get pinged before the team notices.
- **Cache-effectiveness dashboards.** Split on `vx.cache.source` to see
  local vs remote hit rates, or filter by branch/commit/CI provider from
  the root-span attributes.

## Behavior note

This replaces core's old hardcoded OTel emit, which fired automatically
whenever `OTEL_EXPORTER_OTLP_ENDPOINT` was set. OTel is now a **plugin**:
the env var alone no longer auto-exports — you declare `otel()` in
`vx.workspace.ts`. Telemetry is observe-only and can never change, slow,
or fail a run (every export is buffered, time-bounded, and swallows
errors).

For the mechanics of the telemetry capability behind this plugin — and
how to write your own exporter — see [Writing a vx
plugin](/vx/guides/plugins/).
