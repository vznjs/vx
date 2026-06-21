---
title: OpenTelemetry CI/CD spans (native)
description: Pipe every vx run's events into any OTLP-compatible backend. No bridge package — core speaks OTel natively when the env var is set and the peer deps are installed.
---

vx core speaks OpenTelemetry CI/CD-conventions natively when the
optional `@opentelemetry/*` peer deps are installed and
`OTEL_EXPORTER_OTLP_ENDPOINT` points somewhere. No bridge package,
no custom wire format — just the OTLP/HTTP exporter you already use.

## Why OTel

The OpenTelemetry CI/CD semantic conventions
(<https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/>)
define canonical attribute names for every CI concept:
`cicd.pipeline.run.id`, `cicd.pipeline.task.name`,
`cicd.pipeline.task.run.result`, `cicd.worker.id`. Emitting in
this shape means vx events arrive at Grafana / Tempo / Honeycomb /
Datadog / Jaeger / your-self-hosted-collector with zero
integration code.

## Quick start

```sh
# 1. Set the OTLP endpoint (single env var)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=vx

# 2. Install the three OTel optional peer deps in your workspace
bun add @opentelemetry/api-logs \
        @opentelemetry/sdk-logs \
        @opentelemetry/exporter-logs-otlp-http

# 3. Run anything
vx run lint
```

vx checks the env var, dynamically imports the peers, attaches a
log-record processor to the in-process event bus, and pushes every
event through the OTLP/HTTP exporter. Missing env var = silent
skip. Missing peer deps = silent skip. Neither path blocks a run.

## What lands in your backend

Each task's lifecycle becomes an OTel log record:

```jsonc
{
  "timestamp": 1719009123000,
  "severityNumber": 9,                              // INFO; ERROR for failed
  "severityText": "info",
  "body": "task complete: pkg-a#build (success)",
  "attributes": {
    "vx.kind": "task:complete",
    "cicd.pipeline.run.id": "run-1-1719009123000",
    "cicd.pipeline.task.name": "pkg-a#build",
    "cicd.pipeline.task.run.result": "success",
    "vx.task.id": "pkg-a#build",
    "vx.outcome.status": "success",
    "vx.outcome.exit_code": 0,
    "vx.outcome.duration_ms": 123,
    "vx.outcome.hash": "abc123…"
  }
}
```

Plus `run:start`, `task:start`, `task:stdout` / `task:stderr` (the
chunks become log bodies), `run:status`, and `run:end`.

## Backend pointers

The exporter speaks OTLP/HTTP — every major backend accepts it.

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

- **Per-task percentiles.** Backends can aggregate
  `vx.outcome.duration_ms` by `cicd.pipeline.task.name` for p50/p99.
- **Regression alerts.** Alert on "p99 of `lint` exceeds baseline
  by 3×" and your CI dashboard pings before the team notices.
- **Cross-build dashboards.** Filter by `cicd.pipeline.run.id` or
  by repo/branch/commit (when the cloud uploader carries them).

## How it works

`vx run` checks `OTEL_EXPORTER_OTLP_ENDPOINT` at startup. If set
and `options.log` is undefined (the real CLI path, not an
embedder), `src/orchestrator/otel-emit.ts` dynamically imports the
three OTel peers via string-variable specifiers (so TS doesn't try
to resolve them at type-check time and core's dep tree stays at
the same baseline). It subscribes a log-record emitter to the
event bus that translates each WireEvent to an OTel `LogRecord`
with the right semantic-conventions attributes.

On `run:end` the processor flushes pending records and is
detached.

## Limits today

- **Spans, not traces.** Each event is a log record correlated
  with `cicd.pipeline.run.id` — tools that prefer real spans
  (start/end pairs) see flat log streams. Real spans are coming.
- **No metric export.** Only logs/events. Aggregations happen on
  the backend.
- **Local-only attribution.** `cicd.pipeline.run.id` is generated
  per `vx run`; mapping to your CI job (e.g. GHA's
  `${{ github.run_id }}`) takes a tiny shell wrapper or a future
  env-var fold.

See also: [`Wire protocol`](/vx/guides/wire-protocol/).
