# @vzn/vx-otel

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-otel/> · source: <https://github.com/vznjs/vx>

The OpenTelemetry exporter plugin for [`@vzn/vx`](https://vznjs.github.io/vx/). It sends each `vx run` as **OTLP traces, metrics and logs** over HTTP/JSON.

It has no OpenTelemetry SDK dependency. It speaks the OTLP wire protocol directly, so the package has no dependencies and no SDK version to drift.

## Usage

The options type is `OtelPluginOptions`.

```sh
bun add -d @vzn/vx @vzn/vx-otel
```

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel()],
})
```

`otel()` needs **no config**: it reads the standard OTel environment variables.

It **declines safely** (exports nothing) when no endpoint is set, so you can declare it in every environment:

| Variable                                                | Purpose                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                           | base collector URL (e.g. `http://localhost:4318`); one not `https://` (`http://` only to 127.0.0.1, ::1 or localhost: a header is often an API key) is refused with a warning                                                                               |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                    | full traces URL override                                                                                                                                                                                                                                    |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`                   | full metrics URL override                                                                                                                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                      | full logs URL override                                                                                                                                                                                                                                      |
| `OTEL_LOGS_EXPORTER=none`                               | export traces + metrics only (as any list without `otlp`, e.g. `console`)                                                                                                                                                                                   |
| `OTEL_METRICS_EXPORTER=none`                            | no metrics (as any list without `otlp`, e.g. `console`)                                                                                                                                                                                                     |
| `OTEL_TRACES_EXPORTER=none`                             | no traces (as any list without `otlp`, e.g. `console`)                                                                                                                                                                                                      |
| `OTEL_SDK_DISABLED=true`                                | export nothing (the plugin declines)                                                                                                                                                                                                                        |
| `OTEL_SERVICE_NAME`                                     | service name (default `vx`)                                                                                                                                                                                                                                 |
| `OTEL_EXPORTER_OTLP_HEADERS`                            | `k=v,k=v` headers (e.g. auth), percent-encoded                                                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`                   | one signal's headers, over the shared ones                                                                                                                                                                                                                  |
| `OTEL_RESOURCE_ATTRIBUTES`                              | `k=v,k=v` resource attributes, percent-encoded (a malformed one is dropped whole and warned); its `service.name` names the service when `OTEL_SERVICE_NAME` is unset                                                                                        |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                            | per-request timeout in ms (default 15000, at most 2³¹−1); `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` for one signal; a value that is not a positive number warns and is not used. The `timeoutMs` option must be a positive number up to 2³¹−1, or it is refused |
| `OTEL_EXPORTER_OTLP_COMPRESSION`                        | `gzip` or `none` (default), in any case; `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` for one signal, the `compression` option over both, refused if it is neither                                                                                             |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`                        | a PEM file of the CA that signed the collector's certificate (`_<SIGNAL>_` for one signal)                                                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` / `_CLIENT_KEY` | PEM files of a client certificate and key, for a collector that asks for mutual TLS                                                                                                                                                                         |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                           | vx sends OTLP/HTTP JSON only; under `grpc` a failed export says so (`OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL` per signal)                                                                                                                                      |

Each signal ships only to its own URL: the base endpoint's `/v1/<signal>` (appended to its path, before any query), or its override.

A signal's own endpoint alone is enough. With only a metrics or logs endpoint set, that signal exports and the others stay off.

Likewise, with only a traces URL set, metrics and logs are not exported. `metrics: true` or `logs: true` without a URL says so once.

With no signal left to export (each one `none`, `false` or without a URL), the plugin declines, as with no endpoint.

`metrics` and `logs` are booleans: a string is refused, since `'false'` is truthy.

Spans and log records go at most 1 000 and 4 MiB to a request, so a large run stays under a collector's body limit.

<details><summary>Details</summary>

Header names are case-insensitive: a signal's own `Authorization` replaces the shared `authorization`.

A name no header can carry (`Authorization: Basic …` written curl-style, with a colon) is not sent. The warning prints neither its name nor its value.

A `headers` option value that is unset (`process.env.X`, X unset) is left out, as `vxCache({ headers })` leaves it.

Any other value that is not a string is not sent either, with a warning naming the header.

A `content-type` header is not sent: the body is OTLP/HTTP JSON, `application/json`.

</details>

The package exports `otel` and its options type `OtelPluginOptions`. The OTLP builders are internal: the wire they send is the contract (`tests/contract/otlp.txt`).

Options override env, the `endpoint` option included over a signal's own variable:

```ts
otel({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-monorepo',
  headers: { authorization: `Bearer ${process.env.OTLP_TOKEN}` },
  metrics: true, // default
  logs: true, // default: each executed task's output tail
  timeoutMs: 15_000, // default: per request
  compression: 'none', // default; 'gzip' for every signal
  tracesEndpoint: 'https://traces.example.com/v1/traces', // one signal's full URL; also metricsEndpoint, logsEndpoint
})
```

## What it exports

Each run becomes one trace, a set of metrics and, by default, a log record per executed task. They follow the OTel CI/CD and VCS semantic conventions.

**A trace per run**, with a root span, a span per task and a span per stage.

The root `vx.run` span carries:

- `cicd.pipeline.run.id`, `vcs.ref.head.revision`, `vcs.ref.head.name`, the CI provider, host/os/arch and the vx version;
- `vx.command`, the command line. What follows `--` is counted (`-- <N arguments>`), never quoted, and a secret value before it is `***`;
- `cicd.pipeline.result`: `success`, `failure`, or `cancellation` for a run stopped with nothing failed. A red run sets span status `ERROR`;
- the stop's counts: `vx.run.aborted_count`, the tasks it cut short, and `vx.run.not_run_count`, the ones it reached first;
- the remote uploads once they settled: `vx.cache.upload.count`, `.bytes`, `.ms` summed, and `.failed`.

A child `vx.task` span is sent per task, none for one the stop reached before it started.

It starts after any wait for a machine a remote executor reports (a worker's warm-up), which is queue time. Every task span carries:

- `cicd.pipeline.task.name`, and vx's own status as `vx.task.status`;
- `cicd.pipeline.task.run.result`, the convention's enum: `success` for a run or a hit, `failure`, `timeout`, `skip`, `cancellation`;
- `timeout` means vx's own `timeout`, or a server's readiness wait;
- `vx.task.hash`, and the duration (`vx.task.duration_ms`).

<details><summary>Every task span attribute</summary>

- `vx.cache.source`: `miss`, `local` or `remote`. None for a skipped task, one a stop aborted, or a failed hit whose restore threw.
- On a hit, `vx.cache.restored`: `true` when it restored outputs, `false` when they were already up to date.
- The exit code (`vx.task.exit_code`). None on a skipped task, which never ran.
- CPU ms (`vx.cpu_ms`) and peak RSS (`vx.peak_rss_bytes`).
- On a task a plugin executor placed, the machine that ran it (`vx.task.where`).
- On a skipped task, its root blocker (`vx.task.blocked_by`).
- On one skipped for its `exec.platforms`, what it needs and this machine's (`vx.task.platforms_needed`, `vx.task.platform_host`).
- On a server, each dependant's worker ran: `vx.task.carried`.
- On a timed-out one, `vx.task.timed_out`.
- On one whose command exited 0 but left a declared output matching no file, those outputs (`vx.task.outputs_missing`). The exit code 1 is vx's.
- On a sandboxed one, its violation count (`vx.task.sandbox_violations`).
- On a persistent one that never became ready, why (`vx.task.not_ready`).
- Its command (`vx.task.command`), secrets masked.
- On a flaky one, its record (`vx.task.flaky.passes`, `vx.task.flaky.failures`).
- On a hit, what the stored run took: `vx.cache.stored_duration_ms`, `vx.cache.stored_cpu_ms`, `vx.cache.stored_peak_rss_bytes`.
- How long an `admit` policy held it (`vx.task.admission_held_ms`).
- How long it waited ready for a worker (`vx.task.queued_ms`), the hold and a remote executor's wait for a machine included.
- On a cacheable task that ran, how many files its key read (`vx.task.input_files`).
- On a cacheable task that ran, what its key changed since the last entry the cache saved for it: `vx.cache.miss.change_count`, and `vx.cache.miss.changes`.
- `vx.cache.miss.changes` holds the first ten, as `changed file packages/a/src/x.ts`.
- The artifact's size (`vx.cache.artifact_bytes`): a hit's entry, or the one a miss saved.
- A miss's save (`vx.cache.save_ms`) and a remote hit's download (`vx.cache.fetch_ms`).

</details>

A failed task sets span status `ERROR`.

A task span links to the spans of the tasks it waited on. A group is seen through to the tasks behind it.

A task span carries these events:

- `vx.task.retry`, per attempt that failed and was run again, with `vx.task.attempt` and `vx.task.exit_code`;
- `vx.task.timeout`, when vx's own timeout killed it;
- `vx.sandbox.violation`, per sandbox violation, with its line. Past 100, `vx.sandbox.violations_dropped` says how many more.

A child span is sent per stage of the run, named by the stage, with `vx.stage.name`. It shows where the time before the first task and after the last went.

The stages are `startup`, `load configs`, `git enumeration`, `classify + probe`, `run graph`, `record history`, …: the stages `VX_DEBUG_TIMING` prints.

The `vx.run` span covers them. It starts where the first stage does, before the run lock.

That start is the `vx.run.started_at` every task's `vx.task.run_started_at` names.

**Metrics per run**:

- `vx.tasks.total`, the terminal's total, not-run tasks included;
- `vx.tasks.failed`;
- `vx.tasks.cache_hits{source=local|remote}`;
- what those hits did to the disk: `vx.tasks.cache_restored{source=local|remote}` and `vx.tasks.cache_up_to_date`;
- the gauges `vx.run.duration_ms` and `vx.run.time_saved_ms` (what the hits' stored runs took), unit `ms`.

The counts' unit is `{task}`. The `vx.run` span carries the same counts: `vx.run.hit_count`, `vx.run.up_to_date_count`, `vx.run.restored_local_count`, `vx.run.restored_remote_count`.

The counts are DELTA sums over the run's own interval (start to end). So a backend adds runs rather than reading each as the series' new total.

**Metrics per task** are gauges keyed by `cicd.pipeline.task.name`, `vx.task.project` and `vx.task.task`. At each task's end:

- `vx.task.duration` (ms, with `vx.cache.source`);
- for a task the runner measured, `vx.task.cpu_time` (ms) and `vx.task.peak_memory` (bytes);
- on a hit, `vx.task.time_saved` (ms);
- `vx.task.admission_held` (ms) when an `admit` policy held it;
- `vx.task.queued` (ms) when it waited for a worker;
- `vx.task.artifact_size` (bytes), `vx.task.cache_save` and `vx.task.cache_fetch` (ms).

A skipped task, or one a stop aborted, sends none.

While a task runs, its process tree is sampled each second:

- `vx.task.cpu_usage`: cores busy since the last sample, 1 = one core;
- `vx.task.memory`: resident bytes.

Sampling runs only while metrics export. A remote task, or a task under 1 s, has no samples.

**Logs per run** are on by default. Each executed task's captured output tail is sent as one log record at the task's end.

It is plain text: colour and other terminal escapes are dropped. It is linked to its task span; unlinked when traces are off, since the span is never exported.

Build output can hold secrets, and this sends it to the collector. `logs: false` or `OTEL_LOGS_EXPORTER=none` turns it off.

**One run, three signals, linked.** Every request's resource names:

- the run: `service.instance.id` and `cicd.pipeline.run.id`, its id;
- the host: `host.name`, `host.arch`, `os.type`;
- the commit: `vcs.ref.head.*`;
- the repository, from the `origin` remote: `vcs.repository.url.full`, `vcs.repository.name`, `vcs.owner.name`, `vcs.provider.name`;
- `vx.workspace.path`, the workspace root inside the repository (`.` at the top);
- on CI, the run: `cicd.pipeline.run.url.full`, `cicd.pipeline.name`, `vx.ci.job`, `vx.ci.attempt`;
- on CI, the pull request it builds (`vcs.change.id`): GitHub Actions, GitLab, Buildkite, CircleCI.

`OTEL_RESOURCE_ATTRIBUTES` wins over these.

Each task metric point carries its task's span as an exemplar, and each log record its span. So a chart opens the trace, and a span opens its output.

## Live export

Live export is on by default: a dashboard follows a CI run while it runs. `otel({ live: false })` sends everything at the end instead.

- Each task's span, metrics and output tail are sent as the task ends.
- Its process samples are sent as they are taken.
- A log record is sent as the run and each task start (`event.name` `vx.run.start` or `vx.task.start`, linked to the trace).
- The `vx.run` span, the stage spans and the run's metrics follow at the end.

Sends are batched: one per second at most, one in flight at a time, each taking everything that ended meanwhile.

A refused send warns once per signal for the run.

On 60 tasks against a local collector, the run burns the same CPU live as with one send at the end (median of 10: 815 ms both).

No send ever holds a task: a task's end only queues its records.

A collector that never answers holds nothing either. At the end of the run, every send still in flight is cut at core's teardown deadline (3 s), and the process exits.

## Behavior note

The env var alone exports nothing: declare `otel()` in `.vx/workspace.ts`. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` without the plugin sends nothing.

Telemetry only observes. It can never change, slow, or fail a run: every export is buffered, time-bounded, and swallows errors.

A collector shedding load (`429`, `502`, `503`, `504`, or a dropped connection) is retried twice, inside the end-of-run deadline.

The retries wait 200 then 800 ms, or the `Retry-After` the collector names, in seconds or as a date (at most 2 s).

A deadline that passes mid-wait ends the retries and warns the last answer.

A refused connection (nothing listening) is not retried: it warns at once.

Errors are swallowed, but not silent. An export that does not land warns once per signal URL, naming what happened:

- a collector that cannot be reached;
- one that refuses the request (`HTTP 401`, `404`, `500`), with the collector's own message;
- one that accepts it and reports part of the data dropped (OTLP's `partialSuccess`).

One that accepts it all with a message (a `partialSuccess` that rejected nothing, the spec's warning) is said once per signal as that warning, not as a failure.

A collector that answers with a redirect is refused too, naming where it points.

Like the OTel SDK exporters, vx-otel follows no redirect, since a header such as `x-honeycomb-team` would reach the new origin with it.

The URL in that line is printed with any userinfo and query string replaced by `***`. So an endpoint that carries its credential in the URL does not leak it into a CI log.

A header value (or the credential after `Bearer `) that the collector's message echoes is `***` too.

The run stays green either way.

A collector that takes too long is cut off by core's end-of-run deadline (3 s), with a line saying the buffered records were lost.
