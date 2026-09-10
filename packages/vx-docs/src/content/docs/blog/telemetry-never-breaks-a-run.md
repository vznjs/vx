---
title: 'Observability that cannot break a run'
date: 2026-09-10T23:39:00Z
authors:
  - vzn
tags:
  - plugins
  - telemetry
excerpt: "A telemetry sink in vx receives immutable records and a read-only context. There is no API path from a sink back into scheduling, caching or execution, a sink that throws is disabled for the run, and a sink that hangs is cut off after three seconds. The guarantee is structural."
---

Every build tool eventually grows an integration point for "tell
someone what happened": Sentry, Slack, a metrics endpoint, an
OpenTelemetry collector. Every one of those integrations is also a way
for a network hiccup to fail a build, and the usual defence is a
policy: please catch your errors, please do not block.

vx's `telemetry` capability makes it a structure instead.

## The contract

```ts
interface TelemetrySink {
  readonly name?: string
  readonly wants?: ReadonlyArray<'run.start' | 'task.start' | 'task.end' | 'task.log' | 'run.end'>
  onRecord?(record: TelemetryRecord): void          // must return promptly; buffer here
  onRunSummary?(summary: RunSummaryRecord): void    // one per run, at the end
  flush?(): Promise<void>                           // awaited at end of run, time-bounded
}
```

A sink is handed immutable records and a read-only context: the
workspace root, the cache directory, a `warn` function. No event bus,
no cache handle, no run request. There is no method on anything it
receives that reaches scheduling, caching or execution. The guarantee
that a sink cannot change a build is not a rule sinks follow; it is the
absence of a path.

## Crash isolation

- If a sink throws, from `onRecord`, `onRunSummary` or `flush`, it is
  **disabled for the rest of the run** and a warning is printed. Other
  sinks keep receiving records. The run's outcome is unaffected.
- `onRecord` must return promptly, so the contract says buffer and do
  not await. `flush()` is the one awaited drain point, at the end of
  the run, and it is bounded at three seconds per plugin so a wedged
  collector cannot hold the process's exit hostage.
- A sink that lists what it `wants` costs the source nothing for the
  kinds it skips; the large `task.log` stream is off unless asked for.

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

- **`@vzn/vx-otel`** maps each run to OTLP traces and metrics over
  HTTP/JSON with no OpenTelemetry SDK dependency. The wire format is
  small and the SDK is not.
- **`@vzn/vx-github`** writes every run as a GitHub Actions job summary
  and, given a token, a completed check run on the built commit, so a
  red run explains itself in the pull request's checks list.
- Anything else is a few dozen lines: buffer records in `onRecord`,
  post them in `flush`. The guide has runnable Sentry, Slack and
  metrics sinks against the exported types.

## The same rule for remote caches

The never-fail discipline is not only for telemetry. A remote cache
layer that errors, times out or is unreachable degrades to a miss on
that layer, the lookup continues down the chain to the local cache,
and the run completes. Every remote path (get, put, ingest, prefetch)
is wrapped the same way; a remote outage is a slower run, never a
broken one, and a plugin that never fails still warns so you know it
happened.

The guide is [Writing a vx plugin](../../guides/plugins/).
