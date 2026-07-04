---
title: Writing a vx plugin
description: A vx plugin contributes capabilities from vx.workspace.ts — route execution (backend), swap the cache (cache), or export run data (telemetry). The telemetry capability is the safe, observe-only path for Sentry, Slack, metrics, and OpenTelemetry.
---

A plugin is a small object you register in `vx.workspace.ts`. It
contributes one or more **capabilities** to every `vx run`. Most
integrations — forward failures to Sentry, post a summary to Slack,
ship metrics to a timeseries DB — use the **`telemetry`** capability: a
sink that receives immutable run records and, by construction, cannot
change how your tasks run.

Everything below is real, runnable code against the types exported from
`@vzn/vx`. Copy a block, swap the endpoint, and it works.

## The contract

A `VxPlugin` is a plain object with a `name` and any of four optional
capabilities — declared in `vx.workspace.ts` via `defineWorkspace({
plugins: [...] })`. Each capability is independent and opt-in; declaring a
plugin that contributes none is zero-overhead.

```ts
import type { VxPlugin } from '@vzn/vx'

interface VxPlugin {
  readonly name: string // 'org/plugin-name'

  // BEHAVIOR capabilities — change WHAT/HOW work runs (opt-in, first wins):
  backend?(ctx): RunBackend | undefined // route execution (local / remote / distributed)
  cache?(ctx): CacheLayer | undefined // provide the remote cache layer

  // OBSERVE-ONLY capability — cannot change behavior, by construction:
  telemetry?(ctx): TelemetrySink | TelemetrySink[] | undefined // export run data

  setup?(ctx): void | Promise<void> // one-time validation before any capability
  teardown?(): void | Promise<void> // end-of-run flush/close
}
```

- **`backend`** returns a `RunBackend` (`run(request) → result`) or `undefined`
  to decline. First non-undefined wins; else core runs in-process.
- **`cache`** returns a `CacheLayer` wrapping (or replacing) the local cache,
  or `undefined`. First non-undefined wins; else core's `VX_REMOTE_CACHE_*`
  Turbo-wire layer; else the bare local cache. **This is the seam
  `@vzn/vx-cloud` plugs into — and so can you** (see "Bring your own cache").
- **`telemetry`** returns one or more `TelemetrySink`s that receive versioned
  `RunSummaryRecord` / `TelemetryRecord` values. A sink holds NO run handle, so
  it provably can't change a run; ALL plugins' sinks run (additive), each
  crash-isolated. This is the export contract OpenTelemetry, a custom HTTP
  exporter, and vx-cloud all speak.

`@vzn/vx-cloud` is just the first-party plugin that implements all three
against a `vx-cloud serve`. It's fully optional and replaceable — nothing in
core depends on it, and you can implement your own backend/cache/telemetry the
same way.

## The telemetry sink

A `TelemetrySink` is the observe-only surface almost every integration
wants. It receives two record shapes:

```ts
interface TelemetrySink {
  readonly name?: string
  // Which streaming record kinds you want. Default: everything except the
  // large `task.log` stream. Listing kinds means the source pays nothing to
  // project the ones you skip.
  readonly wants?: ReadonlyArray<'run.start' | 'task.start' | 'task.end' | 'task.log' | 'run.end'>
  // A streaming record, one per lifecycle event. MUST return promptly —
  // buffer, do NOT await network I/O here.
  onRecord?(record: TelemetryRecord): void
  // ONE summary per run, at the end — the whole invocation in a single value.
  onRunSummary?(summary: RunSummaryRecord): void
  // Drain buffered data. AWAITED at end-of-run (time-bounded), so this is the
  // right place for network I/O.
  flush?(): Promise<void>
}
```

The `RunSummaryRecord` is the one most integrations need — it arrives
once, at run end, with every task's outcome plus git/CI context:

```ts
interface RunSummaryRecord {
  run: {
    runId: string
    command: string // the invocation, e.g. 'vx run build test'
    commitSha: string | null
    branch: string | null
    ci: boolean
    ciProvider: string | null // 'github' | 'gitlab' | …
    // …workspaceId, tags, os, arch, host, and more
  }
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number // cache hits (local + remote)
  exitOk: boolean
  tasks: ReadonlyArray<{
    taskId: string // 'project#task'
    project: string
    task: string
    status: 'success' | 'failed' | 'skipped' | 'aborted' | 'cache-hit' | 'cache-hit-remote'
    cacheSource: 'miss' | 'local' | 'remote' | 'none'
    exitCode: number
    durationMs: number
    cpuMs?: number
    peakRssBytes?: number
  }>
}
```

## Hello, telemetry

The smallest useful plugin: print a one-line summary after every run.

```ts
// vx.workspace.ts
import { defineWorkspace, type VxPlugin } from '@vzn/vx'

function hello(): VxPlugin {
  return {
    name: 'org/hello',
    telemetry() {
      return {
        name: 'org/hello',
        onRunSummary(summary) {
          const { taskCount, failedCount, hitCount, totalDurationMs } = summary
          console.log(
            `[hello] ${taskCount} tasks · ${failedCount} failed · ${hitCount} cached · ${totalDurationMs}ms`,
          )
        },
      }
    },
  }
}

export default defineWorkspace({ plugins: [hello()] })
```

Run `vx run lint` and the line prints once the run finishes.

## A Sentry plugin (failed tasks → exceptions)

The run summary carries every failure in one value, so you report them
in one place — no per-task event wiring.

```ts
// plugins/sentry.ts
import * as Sentry from '@sentry/node'
import type { VxPlugin } from '@vzn/vx'

export function sentryPlugin(opts: { dsn: string }): VxPlugin {
  Sentry.init({ dsn: opts.dsn })
  return {
    name: 'org/sentry',
    telemetry() {
      return {
        name: 'org/sentry',
        onRunSummary(summary) {
          for (const t of summary.tasks) {
            if (t.status !== 'failed') continue
            Sentry.captureException(new Error(`vx task failed: ${t.taskId}`), {
              tags: {
                project: t.project,
                task: t.task,
                branch: summary.run.branch ?? 'unknown',
                ci: summary.run.ciProvider ?? 'local',
              },
              extra: { exitCode: t.exitCode, durationMs: t.durationMs, commit: summary.run.commitSha },
            })
          }
        },
        // flush() is awaited at end-of-run — give the transport time to ship.
        flush: () => Sentry.flush(2000).then(() => undefined),
      }
    },
  }
}

// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { sentryPlugin } from './plugins/sentry'

export default defineWorkspace({
  plugins: [sentryPlugin({ dsn: process.env.SENTRY_DSN! })],
})
```

## A Slack-summary plugin

Capture the message in `onRunSummary` (which must return promptly), then
do the network POST in `flush()` (which vx awaits). This buffer-then-flush
split is the pattern for any sink that talks to the network.

```ts
// plugins/slack-summary.ts
import type { VxPlugin } from '@vzn/vx'

export function slackSummary(opts: { webhookUrl: string }): VxPlugin {
  return {
    name: 'org/slack-summary',
    telemetry() {
      let text: string | undefined
      return {
        name: 'org/slack-summary',
        onRunSummary(summary) {
          const { failedCount, taskCount, hitCount, totalDurationMs } = summary
          const secs = Math.round(totalDurationMs / 1000)
          text =
            failedCount === 0
              ? `:white_check_mark: vx: ${taskCount} tasks passed (${hitCount} cached) in ${secs}s`
              : `:x: vx: ${failedCount}/${taskCount} tasks failed on ${summary.run.branch ?? 'HEAD'}`
        },
        async flush() {
          if (text === undefined) return
          await fetch(opts.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
        },
      }
    },
  }
}
```

## A metrics plugin (timeseries DB)

For per-task points, stream the `task.end` records. Declaring `wants:
['task.end']` skips every other kind (including the large `task.log`
stream) at the source, so you pay nothing for what you don't read.

```ts
// plugins/timeseries.ts
import type { VxPlugin, TelemetryRecord } from '@vzn/vx'

export function timeseriesPlugin(opts: { url: string }): VxPlugin {
  return {
    name: 'org/timeseries',
    telemetry() {
      const points: Array<Record<string, unknown>> = []
      return {
        name: 'org/timeseries',
        wants: ['task.end'],
        onRecord(record: TelemetryRecord) {
          if (record.kind !== 'task.end') return // narrows the union
          points.push({
            ts: record.ts,
            project: record.project,
            task: record.task,
            status: record.status,
            cache: record.cacheSource, // 'miss' | 'local' | 'remote' | 'none'
            durationMs: record.durationMs,
            cpuMs: record.cpuMs,
          })
        },
        async flush() {
          if (points.length === 0) return
          await fetch(opts.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ points }),
          })
          points.length = 0
        },
      }
    },
  }
}
```

Prefer `onRunSummary` when you want the whole run in one payload;
`onRecord` when you want a live stream of per-task events.

## Bring your own cache (no vx-cloud)

The remote cache is a plugin capability, so you can back it with **anything** —
your own server, S3/R2, Redis — with no vx-cloud involved. Return a
`CacheLayer` from the `cache` capability. The easiest path wraps the local
cache in core's `LayeredCache` pointed at any Turbo-`/v8/artifacts`-compatible
endpoint:

```ts
// vx.workspace.ts
import { defineWorkspace, LayeredCache, RemoteCache, type VxPlugin } from '@vzn/vx'

function myCache(): VxPlugin {
  return {
    name: 'acme/cache',
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline → core falls back to the local cache
      // ctx.localCache is the on-disk cache; ctx.policy carries the run's
      // read/write axes. LayeredCache reads local → remote → hydrates local.
      return new LayeredCache(ctx.localCache, new RemoteCache({ baseUrl: url, token: '…' }), {
        policy: ctx.policy,
        onRemoteError: (e) => ctx.warn(`acme cache: ${e.message}`),
      })
    },
  }
}

export default defineWorkspace({ plugins: [myCache()] })
```

For a fully custom backend (not the Turbo wire), implement the `CacheLayer`
interface directly — `key`, `get`, `save`, `has`, `prefetch`, … — and return
your own object instead of `LayeredCache`. `CacheLayer`, `LayeredCache`,
`RemoteCache`, and `Cache` are all exported from `@vzn/vx`. vx-cloud's `cloud()`
plugin is exactly this pattern; yours sits alongside it as an equal.

## Crash isolation

Plugins are **isolated from execution by design**:

- If **`setup()`** throws, the run aborts with a `UserError` naming the
  plugin. A broken plugin fails loudly, before any work starts.
- If a **`backend`** or **`cache`** factory throws, the run aborts the same
  way — these are load-bearing, so a silent degrade would be worse than a
  clean failure.
- If a **telemetry sink** throws — from `onRecord`, `onRunSummary`, or
  `flush()` — it is **disabled for the rest of the run** and a warning
  prints. Other sinks keep receiving records; the run itself is never
  affected. A sink cannot fail a build.
- `onRecord` / `onRunSummary` **must return promptly** — buffer the data,
  don't `await` network I/O there. `flush()` is the awaited drain point,
  and it's **time-bounded** (3s per plugin) so a wedged sink can't hold the
  run's exit hostage.

The telemetry guarantee is **structural, not a policy**: a `TelemetrySink`
is handed immutable records and a read-only context (`workspaceRoot`,
`cacheDir`, `warn`) — no bus, no cache handle, no run request. There is no
API path from a sink back into scheduling, caching, or execution.

## What a plugin can and can't change

- **Route execution** — yes, via `backend` (local / remote / distributed).
- **Swap the cache** — yes, via `cache` (your own server, S3, Redis).
- **Export run data** — yes, via `telemetry` (observe-only).
- **Change how a task's command runs** — no. Shell is the API
  (architecture principle #3); a plugin never rewrites a task's `exec`.
- **Skip a cache lookup from a hook** — not today. A write-capable
  `onCacheLookup` hook is reserved for a future revision.
- **Register custom MCP/RPC methods** — not today; plugins observe and
  route, they don't extend the inspector surface yet.

Precedence: `backend` and `cache` are **first-non-undefined-wins** in
declaration order (one plugin's backend/cache is used per run). `telemetry`
sinks are **additive** — every plugin's sinks run.

## Reference

- `src/orchestrator/plugin.ts` — the `VxPlugin` interface + capability contexts.
- `src/orchestrator/telemetry.ts` — `TelemetrySink`, `TelemetryRecord`,
  `RunSummaryRecord`, and the versioned schema (`TELEMETRY_SCHEMA_VERSION`).
- `src/orchestrator/plugin-host.ts` — how core consults each capability.
- `tests/telemetry.test.ts`, `tests/plugin-capabilities.test.ts` — worked examples.
- `docs/design/observability-architecture-2026-06.md` — why telemetry is a
  separate, observe-only capability.
