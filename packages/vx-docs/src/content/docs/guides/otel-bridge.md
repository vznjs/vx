---
title: OpenTelemetry traces & metrics
description: Export every vx run as OTLP traces, metrics and logs with the @vzn/vx-otel plugin. No OpenTelemetry SDK is needed.
---

See every run in Grafana, Honeycomb, Datadog or Jaeger: one trace per run,
one span per task. Why a plugin? → [Chapter 9: How vx is built](../../guide/inside-vx/)

## Steps

1. Install: `bun add -d @vzn/vx-otel`.
2. Declare `otel()` in `vx.workspace.ts` (below).
3. Point it at your collector: `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
4. Run anything. Without an endpoint the plugin declines and exports nothing.

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel({ serviceName: 'my-monorepo', headers: { authorization: 'Bearer …' } })],
})
```

| Option            | Env var                                | Default                 |
| ----------------- | -------------------------------------- | ----------------------- |
| `endpoint`        | `OTEL_EXPORTER_OTLP_ENDPOINT`          | none: the plugin declines |
| `tracesEndpoint`  | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`   | `<endpoint>/v1/traces`  |
| `metricsEndpoint` | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`  | `<endpoint>/v1/metrics` |
| `logsEndpoint`    | `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`     | `<endpoint>/v1/logs`    |
| `serviceName`     | `OTEL_SERVICE_NAME`                    | `vx`                    |
| `headers`         | `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,…`) | `{}`                    |
| `metrics`         | none                                   | `true`                  |
| `logs`            | `OTEL_LOGS_EXPORTER=none` turns it off | `true`                  |
| `timeoutMs`       | none                                   | `15000`                 |

## What lands in your backend

| Signal            | Carries                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `vx.run` span     | `vx.run.task_count`, `vx.run.failed_count`, `vx.run.hit_local_count`, `vx.run.hit_remote_count`, `vx.run.exit_ok`, `vx.workspace.id`, `vx.default_branch`, `vx.telemetry.schema` |
| `vx.task` span    | `vx.cache.source`, `vx.task.hash`, `vx.task.attempts`, `vx.task.blocked_by`, `vx.task.timed_out`, `vx.task.sandbox_violations`, `vx.task.not_ready` |
| metrics           | `vx.tasks.total`, `vx.tasks.failed`, `vx.tasks.cache_hits`, `vx.run.duration_ms`                          |
| a log per task    | the task's output, linked to its span; `vx.log.chars_full` says when it was cut                           |

A failed task sets its span status to `ERROR`.

## Common problems

- **Nothing arrives.** The endpoint is unset or empty, so the plugin declined. An export that fails warns once and names the reply.
- **The run waits at the end.** A slow collector is cut off after `timeoutMs`, and the run still exits green.
- **Log attributes are cut.** They are the largest; your collector's attribute limit truncates them first.
