---
title: 'Observability that cannot break a run'
date: 2026-09-10T23:39:00Z
authors:
  - vzn
tags:
  - plugins
  - telemetry
excerpt: "A telemetry sink in vx receives plain-data records and a read-only context. There is no API path from a sink back into scheduling, caching or execution, a sink that throws is disabled for the run, and a sink that hangs is cut off after three seconds. The guarantee is structural."
---

Two broken telemetry plugins: one sink throws on every record, the other
never finishes its `flush`.

```ts
telemetry: () => ({ onRecord() { throw new Error('collector is down') } })
telemetry: () => ({ onRunSummary() {}, flush: () => new Promise<void>(() => {}) })
```

```sh frame="terminal"
$ vx run build test --all
[vx] telemetry sink 'sink-that-throws' threw in onRecord; disabled for this run: collector is down
 ⏺︎     9ms success miss     packages/a#test
 ⏺︎    15ms success miss     packages/b#test
[vx] telemetry flush timed out after 3000ms; buffered records lost
            8 success · 8 total
$ echo $?
0
```

Eight tasks, all green, exit 0, a warning for each broken sink. The
hanging sink cost the run its three-second bound and nothing more (wall
3.19 s; vx `0be0367`, 2026-10-23).

That is not a policy sinks follow. It is the shape of the API.

## The contract

```ts
interface TelemetrySink {
  readonly name?: string
  readonly wants?: ReadonlyArray<'run.start' | 'task.start' | 'task.end' | 'task.log' | 'task.sample' | 'run.end'>
  onRecord?(record: TelemetryRecord): void          // must return promptly; buffer here
  onRunSummary?(summary: RunSummaryRecord): void    // one per run, at the end
  flush?(signal: AbortSignal): Promise<void>        // awaited at end of run, time-bounded;
                                                    // `signal` aborts at the deadline
}
```

A sink is handed plain-data records and a read-only context: the
workspace root, the cache directory, a `warn` function. No event bus,
no cache handle, no run request. There is no method on anything it
receives that reaches scheduling, caching or execution. The guarantee
that a sink cannot change a build is not a rule sinks follow; it is the
absence of a path.

## Crash isolation

| A sink that…                    | What vx does                                            |
| ------------------------------- | ------------------------------------------------------- |
| throws (any method)             | disables it for the run, warns, keeps the others        |
| hangs in `flush`                | cuts every flush off at one shared 3 s bound            |
| blocks in `onRecord`            | the contract says buffer there; `flush` is for I/O     |
| skips kinds via `wants`         | never builds them (`task.log` is off unless asked for)  |

The other direction is isolated too. A plugin whose `setup()` throws
aborts the run before any work starts, naming the plugin, because a
broken plugin should fail loudly and early rather than silently
degrade. An `executor` or `cache` factory that throws aborts the same
way; those are load-bearing.

## Zero cost when absent

The design has a second property that matters as much as safety: **no
telemetry plugin means no telemetry cost**. No bus subscriber is
registered, no run summary is assembled, no `git` is spawned for
provenance. A workspace with no sinks pays nothing for the capability
existing. That is the general rule for every seam in vx: a stage nobody
fills is not a no-op call, it is no call.

## What is built on it

- **`@vzn/vx-otel`** maps each run to OTLP traces, metrics and logs over
  HTTP/JSON with no OpenTelemetry SDK dependency. The wire format is
  small and the SDK is not. Each task's span is sent as the task ends,
  so a dashboard follows a CI run while it runs; no send ever holds a
  task.
- **`@vzn/vx-ci`** writes every run as a GitHub Actions job summary
  and, given a token, a completed check run on the built commit, so a
  red run explains itself in the pull request's checks list.
- Anything else is a few dozen lines: buffer records in `onRecord`,
  post them in `flush`. The guide has a runnable sink against the
  exported types.

## The same rule for remote caches

The never-fail discipline is not only for telemetry. A remote cache
layer that errors, times out or is unreachable degrades to a miss on
that layer, the lookup continues down the chain to the local cache,
and the run completes. Every remote path (get, put, ingest, prefetch)
is wrapped the same way; a remote outage is a slower run, never a
broken one, and a plugin that never fails still warns so you know it
happened.

Guide: [Writing a vx plugin](../../docs/plugins/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
