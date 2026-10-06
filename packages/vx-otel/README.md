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
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel()],
})
```

`otel()` is **zero-config** via the standard OTel environment variables and
**declines safely** (exports nothing) when no endpoint is set — so it is safe
to declare in every environment:

| Variable                                                | Purpose                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                           | base collector URL (e.g. `http://localhost:4318`)                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                    | full traces URL override                                                                                                                                                           |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`                   | full metrics URL override                                                                                                                                                          |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                      | full logs URL override                                                                                                                                                             |
| `OTEL_LOGS_EXPORTER=none`                               | export traces + metrics only                                                                                                                                                       |
| `OTEL_METRICS_EXPORTER=none`                            | no metrics                                                                                                                                                                         |
| `OTEL_TRACES_EXPORTER=none`                             | no traces                                                                                                                                                                          |
| `OTEL_SDK_DISABLED=true`                                | export nothing (the plugin declines)                                                                                                                                               |
| `OTEL_SERVICE_NAME`                                     | service name (default `vx`)                                                                                                                                                        |
| `OTEL_EXPORTER_OTLP_HEADERS`                            | `k=v,k=v` headers (e.g. auth), percent-encoded                                                                                                                                     |
| `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`                   | one signal's headers, over the shared ones                                                                                                                                         |
| `OTEL_RESOURCE_ATTRIBUTES`                              | `k=v,k=v` resource attributes, percent-encoded (a malformed one is dropped whole and warned); its `service.name` names the service when `OTEL_SERVICE_NAME` is unset               |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                            | per-request timeout in ms (default 15000, at most 2³¹−1); `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` for one signal. The `timeoutMs` option must be a positive number, or it is refused |
| `OTEL_EXPORTER_OTLP_COMPRESSION`                        | `gzip` or `none` (default); `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` for one signal, the `compression` option over both                                                           |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`                        | a PEM file of the CA that signed the collector's certificate (`_<SIGNAL>_` for one signal)                                                                                         |
| `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` / `_CLIENT_KEY` | PEM files of a client certificate and key, for a collector that asks for mutual TLS                                                                                                |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                           | vx sends OTLP/HTTP JSON only; under `grpc` a failed export says so (`OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL` per signal)                                                             |

Each signal ships only to its own URL: the base endpoint's `/v1/<signal>`
(appended to its path, before any query), or its override. A signal's own endpoint alone is enough: with only a metrics or logs
endpoint set, that signal exports and the others stay off. Spans and log records go at most 1 000 and 4 MiB to a
request, so a large run stays under a collector's body limit. Header names are case-insensitive (a signal's own
`Authorization` replaces the shared `authorization`); a name no header can
carry (`Authorization: Basic …` written curl-style, with a colon) is not
sent, and the warning prints neither its name nor its value. A `headers`
option value that is not a string is not sent either, with a warning
naming the header.

With only a traces URL set, metrics and logs are not
exported (they used to be POSTed to the traces URL, which a collector
refuses), and `metrics: true` or `logs: true` without a URL says so once.
Both are booleans: a string (`'false'` is truthy) is refused.

The package exports `otel`, its options type `OtelPluginOptions`, and the
types of the `post` option (a `PostFn`: the transport, fetch unless given,
handed each request's URL, body, headers, abort signal and `OtlpTls`). The
OTLP builders are internal (the wire they send is the contract,
`tests/contract/otlp.txt`).

Options override env:

```ts
otel({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-monorepo',
  headers: { authorization: 'Bearer …' },
  metrics: true, // default
  logs: true, // default: each executed task's output tail
  timeoutMs: 15_000, // default: per request
  compression: 'none', // default; 'gzip' for every signal
  tracesEndpoint: 'https://traces.example.com/v1/traces', // one signal's full URL; also metricsEndpoint, logsEndpoint
})
```

## What it exports

**A trace per run** (OTel CI/CD + VCS semantic conventions):

- a root `vx.run` span — `cicd.pipeline.run.id`, `vcs.ref.head.revision`,
  `vcs.ref.head.name`, `vx.command` (the command line; what follows `--`
  is counted, `-- <N arguments>`, never quoted, and a secret value
  before it is `***`), CI provider,
  host/os/arch, vx version, `--tag k=v` →
  `vx.tag.<k>`, and `cicd.pipeline.result` (`success`, `failure`, or
  `cancellation` for a run stopped with nothing failed); a red run sets
  span status `ERROR`;
- a child `vx.task` span per task — `cicd.pipeline.task.name`,
  `cicd.pipeline.task.run.result` (the convention's enum: `success` for a
  run or a hit, `failure`, `timeout`, `skip`, `cancellation`), vx's own
  status as `vx.task.status`, `vx.cache.source` (miss/local/remote, or none for a task that never ran),
  on a hit `vx.cache.restored` (`true` when it restored outputs, `false` when they were already up to date),
  `vx.task.hash`, duration, CPU ms, peak RSS, and on a skipped task its root
  blocker (`vx.task.blocked_by`), on a timed-out one `vx.task.timed_out`, on
  a sandboxed one its violation count (`vx.task.sandbox_violations`), on a
  persistent one that never became ready why (`vx.task.not_ready`), its
  command (`vx.task.command`, secrets masked), on a flaky one its record
  (`vx.task.flaky.passes`, `vx.task.flaky.failures`), on a hit what the
  stored run took (`vx.cache.stored_duration_ms`, `vx.cache.stored_cpu_ms`,
  `vx.cache.stored_peak_rss_bytes`), and how long an `admit` policy held it
  (`vx.task.admission_held_ms`). A
  failed task sets span status
  `ERROR`. A task span links to the spans of the tasks it waited on (a
  group seen through to the tasks behind it), and carries an event per
  attempt that failed and was run again (`vx.task.retry`, with
  `vx.task.attempt` and `vx.task.exit_code`), one when vx's own
  timeout killed it (`vx.task.timeout`), and one per sandbox violation
  (`vx.sandbox.violation`, its line; past 100, `vx.sandbox.violations_dropped`
  says how many more);
- a child span per stage of the run, named by the stage (`startup`,
  `load configs`, `git enumeration`, `classify + probe`, `run graph`,
  `record history`, …, the stages `VX_TIMING` prints), with
  `vx.stage.name`: where the time before the first task and after the
  last went. The stages ahead of the run lock end before the `vx.run`
  span starts.

**Metrics per run**: `vx.tasks.total`, `vx.tasks.failed`,
`vx.tasks.cache_hits{source=local|remote}`, what those hits did to the disk as
`vx.tasks.cache_restored{source=local|remote}` and `vx.tasks.cache_up_to_date`,
and the `vx.run.duration_ms` and `vx.run.time_saved_ms` (what the hits'
stored runs took) gauges. The `vx.run` span carries the same counts
(`vx.run.hit_count`, `vx.run.up_to_date_count`, `vx.run.restored_local_count`,
`vx.run.restored_remote_count`).
The counts are DELTA sums over the run's own interval (start to end), so a
backend adds runs rather than reading each as the series' new total.

**Metrics per task**, as gauges keyed by `cicd.pipeline.task.name`,
`vx.task.project` and `vx.task.task`: at each task's end
`vx.task.duration` (ms, with `vx.cache.source`), and for a task the runner
measured `vx.task.cpu_time` (ms) and `vx.task.peak_memory` (bytes), on a
hit `vx.task.time_saved` (ms), and `vx.task.admission_held` (ms) when an
`admit` policy held it; a skipped task sends none. While a task runs, its process tree is sampled
each second: `vx.task.cpu_usage` (cores busy since the last sample, 1 =
one core) and `vx.task.memory` (resident bytes). Sampling runs only while
metrics export; a remote task, or a task under 1 s, has no samples.

**Logs per run** (on by default): the captured output tail of each executed
task, as one log record at the task's end, linked to its task span (unlinked
when traces are off: the span is never exported). Build output can hold
secrets, and this sends it to the collector; `logs: false` or
`OTEL_LOGS_EXPORTER=none` turns it off.

**One run, three signals, linked.** Every request's resource names the run
(`service.instance.id` and `cicd.pipeline.run.id`, its id), the host
(`host.name`, `host.arch`, `os.type`) and the commit (`vcs.ref.head.*`),
under `OTEL_RESOURCE_ATTRIBUTES`, which wins. Each task metric point carries
its task's span as an exemplar, and each log record its span, so a chart
opens the trace and a span opens its output.

## Live export

```ts
otel({ live: process.env.CI === 'true' })
```

With `live: true` each task's span, metrics and output tail are sent as the
task ends, its process samples as they are taken, and a log record
(`event.name` `vx.run.start` or `vx.task.start`, linked to the trace) as the
run and each task start; the `vx.run` span, the stage spans and the run's
metrics follow at the end. A dashboard follows a CI run while it runs. One
send is in flight at a time and takes everything that ended meanwhile; a
refused send warns once per signal for the run. Cost on 60 tasks against a
local collector: within the noise of run-to-run wall time (min of 6: 1,101 ms
off, 1,108 ms on). Off by default.

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
(OTLP's `partialSuccess`). A collector that answers with a redirect
is refused too, naming where it points: like the OTel SDK exporters,
vx-otel follows none, since a header such as `x-honeycomb-team` would
reach the new origin with it. The URL in that line is printed with any
userinfo and query string replaced by `***`, so an endpoint that carries
its credential in the URL does not leak it into a CI log. The run stays
green either way; a collector that
takes too long is cut off by core's end-of-run deadline
(`VX_TEARDOWN_TIMEOUT_MS`, 3 s by default) with a line saying the buffered
records were lost.
