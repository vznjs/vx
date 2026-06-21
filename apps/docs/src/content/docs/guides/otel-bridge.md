---
title: OpenTelemetry CI/CD spans
description: Pipe every vx run's events into any OTLP-compatible backend (Grafana / Tempo / Honeycomb / Datadog / Jaeger). Single env var, single npm install, zero config in code.
---

vx ships an opt-in OpenTelemetry exporter at
`@vzn/vx-otel-bridge`. Set one env var, install one package, and
every `vx run` emits OTel CI/CD-conventions log records to your
existing observability stack.

## Why OTel

The OpenTelemetry CI/CD semantic conventions
(<https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/>)
define canonical attribute names for every CI concept:
`cicd.pipeline.run.id`, `cicd.pipeline.task.name`,
`cicd.pipeline.task.run.result`, `cicd.worker.id`. By emitting in
this shape, vx events arrive at Grafana / Tempo / Honeycomb /
Datadog / Jaeger / your-self-hosted-collector without any
integration code — they already understand the spec.

## Quick start

```sh
# 1. Set the OTLP endpoint (single env var)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=vx

# 2. Install the bridge in your workspace
bun add @vzn/vx-otel-bridge

# 3. Run anything
vx run lint
```

vx detects the env var, dynamically imports the bridge, and
attaches it as an additional event-bus subscriber. Every task's
lifecycle becomes an OTel log record.

If the env var is unset, or the bridge package isn't installed,
core gains nothing — the runtime stays at 19 packages.

## What lands in your backend

For each task, vx emits a `task:complete` record shaped like:

```jsonc
{
  "timeUnixNano": "1719009123000000000",
  "severityNumber": 9,                              // INFO; 17 for failed
  "severityText": "info",
  "body": "pkg-a#build → success (123ms)",
  "traceId": "01931d80-2c0c-7000-8000-000000000000", // vx run id
  "spanId": "pkg-a#build",                          // task id
  "attributes": {
    "vx.kind": "task:complete",
    "cicd.pipeline.run.id": "01931d80-2c0c-7000-8000-000000000000",
    "cicd.pipeline.task.name": "pkg-a#build",
    "cicd.pipeline.task.run.result": "success",
    "vx.outcome": {
      "status": "success",
      "exitCode": 0,
      "durationMs": 123,
      "cacheHit": false
    }
  }
}
```

Plus `run:start`, `task:start`, `task:stdout` / `task:stderr` (the
chunks become log bodies), `run:status`, and `run:end`.

## Backend pointers

The bridge speaks OTLP/HTTP — every major backend accepts it.

```sh
# Grafana Cloud / Tempo
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64-creds>"

# Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<api-key>"

# Datadog (via OTel collector)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Jaeger (running locally)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Any header your backend requires can be set via
`OTEL_EXPORTER_OTLP_HEADERS=key1=val1,key2=val2` — the standard
OTLP discovery rules apply (`@opentelemetry/exporter-logs-otlp-http`
handles it).

## What this gives you

- **Per-run timelines.** Each `vx run` is a trace; each task is a
  log record with the run's trace id. Tools that show distributed
  traces show every task of a run grouped.
- **Per-task percentiles.** Honeycomb / Grafana can aggregate
  `durationMs` by `cicd.pipeline.task.name` for p50/p99.
- **Regression alerts.** Set up an alert on "p99 of `lint` exceeds
  baseline by 3×" and your CI dashboard pings before the team
  notices.
- **Cross-build dashboards.** Filter by `cicd.pipeline.run.id` or
  by repo/branch/commit (when the cloud uploader carries them).

## How it works

`vx run` checks `OTEL_EXPORTER_OTLP_ENDPOINT` at startup. If set
and `options.log` is undefined (i.e. the real CLI path, not an
embedder), it dynamically imports `@vzn/vx-otel-bridge` via a
string-variable specifier (so the optional peer doesn't bloat
core's dep tree). The bridge's `createOtelBridge({ endpoint,
serviceName }).attach(bus)` subscribes to the event bus and pushes
each event through an OTLP log-record exporter.

On `run:end`, the bridge flushes pending records and is detached.

## Limits today

- **Spans, not traces.** Each event is a log record correlated with
  a synthetic span id — tools that prefer real spans (start/end
  pairs) see flat log streams. Real spans are coming.
- **No metric export.** Only logs/events. Aggregations need to
  happen on the backend side.
- **Local-only attribution.** `cicd.pipeline.run.id` is vx's run
  UUIDv7; mapping to your CI job (e.g. GHA's `${{ github.run_id }}`)
  takes a tiny shell wrapper or a future env-var fold.

## Combining with vx Cloud

`vx-cloud` (the Cloudflare deployment) also persists events to D1
via the EVENT_INGEST queue. The two are independent — you can run
either, both, or neither. OTel is the "ship to my existing
observability stack"; vx Cloud is the "spin up vx-native dashboards
in my CF account."

See also: `packages/otel-bridge/README.md`,
`docs/design/wire-protocol-2026-06.md` §4 (the OTel LogRecord
shape).
