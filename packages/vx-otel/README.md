# @vzn/vx-otel

The OpenTelemetry exporter plugin for [`@vzn/vx`](https://github.com/vznjs/vx).
Maps each `vx run` to **OTLP traces, metrics and logs** over HTTP/JSON — no
OpenTelemetry SDK dependency (it speaks the OTLP wire protocol directly, so the
package stays zero-dependency and version-drift-free).

## Usage

The options type is `OtelPluginOptions`.

```sh
npm install -D @vzn/vx @vzn/vx-otel   # or: pnpm add -D -w · yarn add -D (-W on Yarn 1) · bun add -d
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel()],
})
```

`otel()` is **zero-config** via the standard OTel environment variables and
**declines safely** (exports nothing) when no endpoint is set — so it is safe
to declare in every environment:

| Variable                                                | Purpose                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                           | base collector URL (e.g. `http://localhost:4318`)                                                                                                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                    | full traces URL override                                                                                                                                             |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`                   | full metrics URL override                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                      | full logs URL override                                                                                                                                               |
| `OTEL_LOGS_EXPORTER=none`                               | export traces + metrics only                                                                                                                                         |
| `OTEL_METRICS_EXPORTER=none`                            | no metrics                                                                                                                                                           |
| `OTEL_TRACES_EXPORTER=none`                             | no traces                                                                                                                                                            |
| `OTEL_SDK_DISABLED=true`                                | export nothing (the plugin declines)                                                                                                                                 |
| `OTEL_SERVICE_NAME`                                     | service name (default `vx`)                                                                                                                                          |
| `OTEL_EXPORTER_OTLP_HEADERS`                            | `k=v,k=v` headers (e.g. auth), percent-encoded                                                                                                                       |
| `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`                   | one signal's headers, over the shared ones                                                                                                                           |
| `OTEL_RESOURCE_ATTRIBUTES`                              | `k=v,k=v` resource attributes, percent-encoded (a malformed one is dropped whole and warned); its `service.name` names the service when `OTEL_SERVICE_NAME` is unset |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                            | per-request timeout in ms (default 15000, at most 2³¹−1); `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` for one signal                                                       |
| `OTEL_EXPORTER_OTLP_COMPRESSION`                        | `gzip` or `none` (default); `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` for one signal, the `compression` option over both                                             |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`                        | a PEM file of the CA that signed the collector's certificate (`_<SIGNAL>_` for one signal)                                                                           |
| `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` / `_CLIENT_KEY` | PEM files of a client certificate and key, for a collector that asks for mutual TLS                                                                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                           | vx sends OTLP/HTTP JSON only; under `grpc` a failed export says so                                                                                                   |

Each signal ships only to its own URL: the base endpoint's `/v1/<signal>`
(appended to its path, before any query), or its override. A signal's own endpoint alone is enough: with only a metrics or logs
endpoint set, that signal exports and the others stay off. Spans and log records go at most 1 000 and 4 MiB to a
request, so a large run stays under a collector's body limit. Header names are case-insensitive (a signal's own
`Authorization` replaces the shared `authorization`); a name no header can
carry (`Authorization: Basic …` written curl-style, with a colon) is not
sent, and the warning prints neither its name nor its value.

With only a traces URL set, metrics and logs are not
exported (they used to be POSTed to the traces URL, which a collector
refuses), and `metrics: true` or `logs: true` without a URL says so once.

Options override env:

```ts
otel({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-monorepo',
  headers: { authorization: 'Bearer …' },
  metrics: true, // default
  logs: true, // default: each executed task's output tail
})
```

## What it exports

**A trace per run** (OTel CI/CD + VCS semantic conventions):

- a root `vx.run` span — `cicd.pipeline.run.id`, `vcs.ref.head.revision`,
  `vcs.ref.head.name`, `vx.command` (the command line; what follows `--`
  is counted, `-- <N arguments>`, never quoted), CI provider,
  host/os/arch, vx version, `--tag k=v` →
  `vx.tag.<k>`, and `cicd.pipeline.result` (`success`, `failure`, or
  `cancellation` for a run stopped with nothing failed); a red run sets
  span status `ERROR`;
- a child `vx.task` span per task — `cicd.pipeline.task.name`,
  `cicd.pipeline.task.run.result` (the convention's enum: `success` for a
  run or a hit, `failure`, `timeout`, `skip`, `cancellation`), vx's own
  status as `vx.task.status`, `vx.cache.source` (miss/local/remote),
  `vx.task.hash`, duration, CPU ms, peak RSS, and on a skipped task its root
  blocker (`vx.task.blocked_by`), on a timed-out one `vx.task.timed_out`, on
  a sandboxed one its violation count (`vx.task.sandbox_violations`), on a
  persistent one that never became ready why (`vx.task.not_ready`). A
  failed task sets span status
  `ERROR`.

**Metrics per run**: `vx.tasks.total`, `vx.tasks.failed`,
`vx.tasks.cache_hits{source=local|remote}`, and the `vx.run.duration_ms` gauge.
The counts are DELTA sums over the run's own interval (start to end), so a
backend adds runs rather than reading each as the series' new total.

**Logs per run** (on by default): the captured output tail of each executed
task, as one log record linked to its task span (unlinked when traces are
off: the span is never exported). Build output can hold
secrets, and this sends it to the collector; `logs: false` or
`OTEL_LOGS_EXPORTER=none` turns it off.

## Behavior note

This replaces core's previous hardcoded OTel emit, which fired automatically
whenever `OTEL_EXPORTER_OTLP_ENDPOINT` was set. OTel is now a **plugin**: the
env var alone no longer auto-exports — you must declare `otel()` in
`vx.workspace.ts`. Telemetry is observe-only and can never change, slow, or
fail a run (every export is buffered, time-bounded, and swallows errors).

A collector shedding load (`429`, `502`, `503`, `504`, or a dropped
connection) is retried twice, 200 then 800 ms apart or after the
`Retry-After` it names (at most 2 s), inside the end-of-run deadline; a
deadline that passes mid-wait ends the retries and warns the last answer.

Swallowed, but not silent: an export that does not land warns once per
signal URL, naming what happened — a collector that cannot be reached, one
that refuses the request (`HTTP 401`, `404`, `500`, with the collector's own
message), or one that accepts it and reports part of the data dropped
(OTLP's `partialSuccess`). The URL in that line is printed with any
userinfo and query string replaced by `***`, so an endpoint that carries
its credential in the URL does not leak it into a CI log. The run stays
green either way; a collector that
takes too long is cut off by core's end-of-run deadline
(`VX_TEARDOWN_TIMEOUT_MS`, 3 s by default) with a line saying the buffered
records were lost.
