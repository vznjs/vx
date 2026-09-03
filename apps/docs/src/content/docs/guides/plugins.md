---
title: Writing a vx plugin
description: A vx plugin contributes capabilities from vx.workspace.ts — decide where a task runs (executor), where artifacts live (cache), or where run records go (telemetry). Telemetry is the safe, observe-only path for Sentry, Slack, metrics, and OpenTelemetry.
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

A `VxPlugin` is a plain object with a `name` and any of the optional
hooks below — declared in `vx.workspace.ts` via `defineWorkspace({
plugins: [...] })`. Each hook is independent and opt-in; a stage nobody
declares costs nothing, and declaration order is the order everywhere.

```ts
import type { VxPlugin } from '@vzn/vx'

interface VxPlugin {
  readonly name: string // 'org/plugin-name'

  // PIPELINE stages — shape the run before it executes:
  config?(workspace, ctx): void // the workspace config, before it is used
  project?(config, ctx): void // one loaded project's tasks: add / remove / edit
  graph?(nodes, ctx): void // the task graph: edges, requested, resources
  key?(task, ctx): Record<string, string> // extra cache-key material per task
  schedule?(nodes, ctx): Map<string, number> // task id → priority among ready tasks

  // BEHAVIOR capabilities — decide WHERE work runs and where artifacts live:
  executor?(ctx): TaskExecutor | undefined // where ONE task's command runs
  cache?(ctx): CacheLayer | undefined // where artifacts live

  // OBSERVE-ONLY capability — cannot change behavior, by construction:
  telemetry?(ctx): TelemetrySink | TelemetrySink[] | undefined // export run data

  // CLI verbs — consulted for a word core does not know:
  commands?: { [verb]: { description: string; run(argv, ctx): number } }

  setup?(ctx): void | Promise<void> // one-time validation before any capability
  teardown?(): void | Promise<void> // end-of-run flush/close
}
```

## Adding a verb

`commands` adds words to the `vx` CLI. Core's verbs are matched first —
nothing can shadow `vx run` — and a plugin verb runs only when the cwd
is inside a workspace that declares the plugin. `vx help` lists them.

```ts
export function mcp(): VxPlugin {
  return {
    name: 'org/mcp',
    commands: {
      mcp: {
        description: 'serve run history to an AI agent over stdio',
        async run(argv, ctx) {
          const db = new Cache(ctx.cacheDir).dbHandle() // the same queries `vx why` reads
          // … speak MCP on stdin/stdout …
          return 0 // the process exit code — resolving anything else fails the verb
        },
      },
    },
  }
}
```

## Shaping the pipeline

The three stage hooks are how a plugin **adds** something to every
project without every `vx.config.ts` repeating it. Core re-validates
whatever a stage produced, so a plugin can only create what the loader
would accept from you — and the cache key hashes the task config
*after* `project` ran, so an injected task is keyed exactly like one you
wrote by hand.

A plugin that gives every TypeScript package a `typecheck` task:

```ts
import type { VxPlugin } from '@vzn/vx'

export function typecheck(): VxPlugin {
  return {
    name: 'org/typecheck',
    project(config, ctx) {
      if (!ctx.packageJson['devDependencies']?.['typescript']) return
      config.tasks ??= {}
      config.tasks['typecheck'] ??= {
        exec: { command: 'tsc --noEmit' },
        cache: { inputs: { files: ['src/**', 'tsconfig.json'] }, outputs: { files: [] } },
      }
    },
  }
}
```

A plugin that makes every `test` wait for its project's `build`:

```ts
export function testAfterBuild(): VxPlugin {
  return {
    name: 'org/test-after-build',
    graph(nodes) {
      for (const node of nodes.values()) {
        if (node.taskName !== 'test') continue
        const build = `${node.projectName}#build`
        if (nodes.has(build) && !node.deps.includes(build)) node.deps.push(build)
      }
    },
  }
}
```

A dep naming a task that is not in the run, or a cycle, is refused with
the plugin's name and the stage: `plugin 'org/test-after-build' failed in
graph: …`. `config` runs first and sees the workspace config before
`concurrency` or `cacheDir` are read from it.

### Keys and order

`key` adds material the declared inputs cannot see — a tool version, a
feature flag — to every task's cache key. It is folded only when a
plugin contributes something, so keys without it are unchanged, and
`vx why` names it as a `plugin` component:

```ts
export function nodeMajor(): VxPlugin {
  const major = process.versions.node.split('.')[0]!
  return { name: 'org/node-major', key: () => ({ 'node-major': major }) }
}
```

`schedule` decides which READY task runs first when more are ready than
there are workers. Return `Map<taskId, weight>`; higher runs first, and
the scheduler's structural baseline (how many tasks a task unblocks)
stays the tie-break. Core ships one reference policy — the expected
remaining critical path learned from your own run history:

```ts
import { scheduleHistoryPlugin } from '@vzn/vx/plugins/schedule-history'

export default defineWorkspace({
  plugins: [scheduleHistoryPlugin(), localExecutorPlugin(), localCachePlugin()],
})
```

It costs one history read per run, in the workspaces that declare it —
which is why it is a plugin and not a flag.

- **`executor`** returns a `TaskExecutor` — the thing that actually runs
  one task's command — or `undefined` to decline. Executors form a
  **list** in declaration order, and per task the first one whose
  `accepts(task)` returns true gets it. That is how `@vzn/vx-reapi` can
  run most tasks on a remote worker while a task marked
  `exec: { remote: false }` still falls to the local executor in the
  same run. Declaring none is an authoring error, not a default: vx does
  not assume even a local executor.
- **`cache`** returns a `CacheLayer` or `undefined`. Layers **chain**
  rather than compete: a lookup walks them in order and a save reaches
  all of them, so a remote plugin declared before `localCachePlugin()`
  composes with it instead of replacing it. (A bare local layer that
  another declared layer already wraps is dropped, so the local store is
  never written twice.) Core ships no wire client of its own.
- **`telemetry`** returns one or more `TelemetrySink`s that receive versioned
  `RunSummaryRecord` / `TelemetryRecord` values. A sink holds NO run handle, so
  it provably can't change a run; ALL plugins' sinks run (additive), each
  crash-isolated and deadline-bounded. This is the export contract
  `@vzn/vx-otel`, `@vzn/vx-github` and any custom exporter all speak.

The plugins that ship alongside vx are ordinary consumers of these same
seams: `@vzn/vx-reapi` fills `executor` and `cache` against any Bazel
REAPI server, `@vzn/vx-otel` and `@vzn/vx-github` fill `telemetry`. None
of them is privileged — core depends on none, and yours plugs in the
same way. Even vx's own `localExecutorPlugin()` and `localCachePlugin()`
are written against the public contract.

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

## Bring your own cache

The remote cache is a plugin capability, so you can back it with **anything** —
your own server, a Turbo-compatible cache, S3/R2, Redis — with no cloud
platform involved. The easiest path implements core's three-call `RemoteCacheLayer`
seam (`has`/`get`/`put`) and wraps the local cache in `LayeredCache`, which
then owns policy gating, deduplication, provenance, and the never-fail
degradation for you:

```ts
// vx.workspace.ts
import { defineWorkspace, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class AcmeRemote implements RemoteCacheLayer {
  constructor(private url: string) {}
  async has(hash: string) {
    return (await fetch(`${this.url}/artifacts/${hash}`, { method: 'HEAD' })).ok
  }
  async get(hash: string) {
    const res = await fetch(`${this.url}/artifacts/${hash}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`) // throws degrade to a miss
    return { body: await res.arrayBuffer(), durationMs: undefined }
  }
  async put(hash: string, body: ArrayBuffer | Uint8Array) {
    await fetch(`${this.url}/artifacts/${hash}`, { method: 'PUT', body })
  }
}

function myCache(): VxPlugin {
  return {
    name: 'acme/cache',
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline → core falls back to the local cache
      // ctx.localCache is the on-disk cache; ctx.policy carries the run's
      // read/write axes. LayeredCache reads local → remote → hydrates local.
      return new LayeredCache(ctx.localCache, new AcmeRemote(url), {
        policy: ctx.policy,
        onRemoteError: (e) => ctx.warn(`acme cache: ${e.message}`),
      })
    },
  }
}

export default defineWorkspace({ plugins: [myCache()] })
```

A **Turbo-wire plugin** is exactly this shape with `/v8/artifacts/:hash`
URLs and `x-artifact-*` headers inside the class. For a fully custom
layering (not just a different wire), implement the `CacheLayer` interface
directly — `key`, `get`, `save`, `has`, `prefetch`, … — and return your own
object instead of `LayeredCache`. `CacheLayer`, `RemoteCacheLayer`,
`LayeredCache`, and `Cache` are all exported from `@vzn/vx`. The first-party
cloud plugin is exactly this pattern; yours sits alongside it as an equal.

## Crash isolation

Plugins are **isolated from execution by design**:

- If **`setup()`** throws, the run aborts with a `UserError` naming the
  plugin. A broken plugin fails loudly, before any work starts.
- If an **`executor`** or **`cache`** factory throws, the run aborts the same
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

- **Decide where a task runs** — yes, via `executor` (this machine, a
  remote worker pool, a container).
- **Swap the cache** — yes, via `cache` (your own server, S3, Redis).
- **Export run data** — yes, via `telemetry` (observe-only).
- **Change how a task's command runs** — no. Shell is the API
  (architecture principle #3); a plugin never rewrites a task's `exec`.
- **Skip a cache lookup from a hook** — not today. A write-capable
  `onCacheLookup` hook is reserved for a future revision.
- **Register custom MCP/RPC methods** — not today; plugins observe and
  route, they don't extend the inspector surface yet.

Precedence, and it differs per seam — this is the part worth reading
twice. `executor` is a **list**: per task, the first executor that
`accepts` it wins. `cache` layers **chain**: a lookup walks them in
declaration order, a save reaches all. `telemetry` sinks are
**additive**: every plugin's sinks run.

## Reference

- `src/orchestrator/plugin.ts` — the `VxPlugin` interface + capability contexts.
- `src/orchestrator/telemetry.ts` — `TelemetrySink`, `TelemetryRecord`,
  `RunSummaryRecord`, and the versioned schema (`TELEMETRY_SCHEMA_VERSION`).
- `src/orchestrator/plugin-host.ts` — how core consults each capability.
- `tests/telemetry.test.ts`, `tests/plugin-capabilities.test.ts` — worked examples.
- `docs/design/observability-architecture-2026-06.md` — why telemetry is a
  separate, observe-only capability.
