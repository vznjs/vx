---
title: OpenTelemetry traces & metrics
description: Export every vx run as OTLP traces, metrics and logs with the @vzn/vx-otel plugin. Declare otel() in vx.workspace.ts; it speaks OTLP/HTTP JSON directly with no OpenTelemetry SDK dependency.
---

`@vzn/vx-otel` turns every `vx run` into **OTLP traces, metrics and
logs** — one trace per run, one span per task, run/task counters, and
each executed task's captured output as a log record linked to its span.
It speaks the OTLP/HTTP JSON wire protocol **directly**, so there's no
OpenTelemetry SDK dependency and nothing to keep version-matched.

The export is **lossless**: every field of vx's telemetry contract rides
the wire, so a backend reading the trace can rebuild the whole run. That
is what makes OTLP a real integration surface rather than a summary —
including for [vx Cloud itself](#send-it-to-vx-cloud), which accepts
OTLP as an ingest wire.

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
| `logsEndpoint`   | `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | `<endpoint>/v1/logs`       |
| `serviceName`    | `OTEL_SERVICE_NAME`                   | `vx`                       |
| `headers`        | `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,…`)| `{}`                       |
| `metrics`        | —                                     | `true`                     |
| `logs`           | `OTEL_LOGS_EXPORTER=none` disables    | `true`                     |
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
  The root span also carries the workspace identity
  (`vx.workspace.id` / `vx.workspace.name`), the repository's default
  branch (`vx.default_branch`), the run tallies (`vx.run.task_count`,
  `vx.run.failed_count`, `vx.run.hit_local_count`,
  `vx.run.hit_remote_count`, `vx.run.exit_ok`) and
  `vx.telemetry.schema`, the contract version a reader should check
  before trusting the rest;
- a child **`vx.task`** span per task — `cicd.pipeline.task.name`,
  `cicd.pipeline.task.run.result`, `vx.cache.source`
  (`miss`/`local`/`remote`), `vx.task.hash`, duration, CPU ms, peak RSS,
  retry count (`vx.task.attempts`), the [`--verify`](/vx/cli/) verdict
  (`vx.task.verify`, plus the diverging paths) and the output
  fingerprint (`vx.task.output_fp.*`). A failed task sets the span
  status to `ERROR` — and so does a task that exited 0 but whose verify
  verdict proved its cache entry unsound.

**Metrics per run** (when `metrics` is on): `vx.tasks.total`,
`vx.tasks.failed`, `vx.tasks.cache_hits{source=local|remote}`, and the
`vx.run.duration_ms` gauge.

**A log record per executed task** (when `logs` is on): the task's
captured output, linked to its `vx.task` span by trace and span id, so
you open the log from the span. One record per task rather than per
chunk — a build writes its output in thousands of tiny pieces, and the
thing anyone reads is the tail.

Capture is bounded exactly as the cloud sink bounds it: a per-task tail
cap, a per-run budget, and failed tails are never dropped to keep a
successful one. A cache hit ships no record — those bytes belong to the
run that executed the task, and you find them by its cache key. Every
truncation reports itself (`vx.log.chars_full`,
`vx.log.truncated_head`), so a capped tail never reads as a complete
one.

Set `logs: false` (or the standard `OTEL_LOGS_EXPORTER=none`) to export
traces and metrics only; vx then stops capturing output for export
entirely, so the run pays nothing.

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

## Send it to vx Cloud

[vx Cloud](/vx/cloud/overview/) accepts OTLP as an ingest wire, so the
same export that feeds your tracing backend can populate the dashboard —
no vx-specific client needed:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.example.com/v1/otlp
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer vxc_…"
```

It decodes into the same records the native `/v1/ingest` endpoints take
and lands in the same store, so both wires give you the same dashboard.
Point a collector at both if you want traces in Grafana **and** history
in vx Cloud.

A collector in the middle is expected, not merely tolerated. It batches
across producers and re-batches by size and time, so one export can
carry several runs and one run can be split across exports. Both are
handled: spans are grouped by trace, so batched runs never borrow each
other's tasks, and a task span names its own run, workspace and run
start, so a task that arrives ahead of its header is stored anyway and
converges on the same row when the header lands.

The one thing a collector can still cost you is attribute limits. The
output fingerprint's per-file map is the largest attribute and the first
to be truncated — which costs a cross-machine diff its detail, never its
verdict, because detection keys on the fixed-width tree digest. The
native endpoints have no such exposure, which is why they remain the
default.

## Build your own analytics

The attributes above are the whole contract — nothing about them is
private to vx Cloud. A receiver reads the `vx.run` span for the
invocation header and each `vx.task` span for a task result, checks
`vx.telemetry.schema`, and has everything vx knows about the run.

vx Cloud's own receiver is one file
(`packages/cloud/src/db/otlp-ingest.ts`) and is a worked example: it
decodes OTLP back into the canonical records and hands them to the
ordinary ingest.

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
