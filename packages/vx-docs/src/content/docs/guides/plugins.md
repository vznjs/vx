---
title: Plugins
description: Write a plugin that fills one or more stages of every run, export runs to OpenTelemetry, and let an AI agent read your workspace with vx mcp.
---

Change every run from one place: add tasks, key material, a cache, an
exporter or a CLI verb.

## Write one

A plugin is a function that returns `definePlugin(import.meta, hooks)`.
Its name is its package's name. Fill only the hooks you need; an unfilled
hook costs nothing. Declare it in `vx.workspace.ts`
(`plugins: [typecheck()]`), and `vx info` lists it with its hooks. To test
it, call `run()` from `@vzn/vx` on a throwaway workspace.

This one gives every TypeScript package a `typecheck` task:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function typecheck(): VxPlugin {
  return definePlugin(import.meta, {
    project(config, ctx) {
      const dev = ctx.packageJson['devDependencies'] as Record<string, string> | undefined
      if (!dev?.['typescript']) return
      config.tasks ??= {}
      config.tasks['typecheck'] ??= {
        exec: { command: 'tsc --noEmit' },
        cache: { inputs: { files: ['src/**', 'tsconfig.json'] }, outputs: { files: [] } },
      }
    },
  })
}
```

## The hooks

Plugins are asked in the order you list them. What every plugin declines
runs and is stored on this machine.

| Stage       | Hook                   | Decides                                                   |
| ----------- | ---------------------- | --------------------------------------------------------- |
| config      | `config(ws, ctx)`      | the workspace config, before it is used                   |
| project     | `project(config, ctx)` | a project's tasks: add, remove, rewrite                   |
| graph       | `graph(nodes, ctx)`    | the run's edges                                           |
| key         | `key(task, ctx)`       | extra cache-key material, named in `vx why`               |
| fingerprint | `fingerprint`          | a lockfile keyed per project instead of per workspace     |
| schedule    | `schedule(nodes, ctx)` | which ready task runs first                               |
| admit       | `admit(task, ctx)`     | whether a ready task starts now, beside what runs here    |
| execute     | `executor(ctx)`        | where one task's command runs                             |
| store       | `cache(ctx)`           | where artifacts live                                      |
| observe     | `telemetry(ctx)`       | where run records go; it can never change the run         |
| setup       | `setup(ctx)`           | once per run, before the first task                       |
| cli         | `commands`             | which verbs `vx` has                                      |
| teardown    | `teardown()`           | flush and close at the end of the run                     |

```ts
import type { VxPlugin } from '@vzn/vx'

interface VxPlugin {
  readonly name: string // your package's name: definePlugin reads it
  config?(workspace, ctx): void
  project?(config, ctx): void
  graph?(nodes, ctx): void
  key?(task, ctx): Record<string, string>
  fingerprint?: { files; affected(change, ctx) }
  schedule?(nodes, ctx): Map<string, number>
  admit?(task, ctx): boolean
  executor?(ctx): TaskExecutor | undefined
  cache?(ctx): CacheLayer | undefined
  telemetry?(ctx): TelemetrySink | TelemetrySink[] | undefined
  commands?: { [verb]: { description: string; run(argv, ctx): number } }
  setup?(ctx): void | Promise<void>
  teardown?(): void | Promise<void>
}
```

## Keys and order

`key` adds what your inputs cannot see, like a tool version:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function nodeMajor(): VxPlugin {
  const major = process.versions.node.split('.')[0]!
  return definePlugin(import.meta, { key: () => ({ 'node-major': major }) })
}
```

`admit` holds a ready task back. Here, one e2e suite at a time:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function oneDatabase(): VxPlugin {
  return definePlugin(import.meta, {
    admit(task, ctx) {
      if (!task.id.endsWith('#e2e')) return true
      return !ctx.running.some((r) => r.id.endsWith('#e2e'))
    },
  })
}
```

`schedule` ranks ready tasks. This one learns from your run history:

```ts
import { defineWorkspace } from '@vzn/vx'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default defineWorkspace({ plugins: [scheduleHistoryPlugin()] })
```

## A verb and a sink

`commands` adds a verb. A telemetry sink gets each run's summary; do
network I/O in `flush()`, which vx awaits for up to 3 s.

```ts
import { Cache, definePlugin, type VxPlugin } from '@vzn/vx'

export function mcp(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      mcp: {
        description: 'serve run history to an AI agent over stdio',
        async run(argv, ctx) {
          const db = new Cache(ctx.cacheDir).dbHandle() // the tables `vx why` reads
          void argv
          void db
          return 0 // the exit code
        },
      },
    },
  })
}
```

```ts
import { definePlugin, defineWorkspace, type VxPlugin } from '@vzn/vx'

function hello(): VxPlugin {
  return definePlugin(import.meta, {
    telemetry() {
      return {
        onRunSummary(summary) {
          const { taskCount, failedCount, hitCount, totalDurationMs } = summary
          console.log(`${taskCount} tasks · ${failedCount} failed · ${hitCount} cached · ${totalDurationMs}ms`)
        },
      }
    },
  })
}

export default defineWorkspace({ plugins: [hello()] })
```

## Your own cache

Implement core's `RemoteCacheLayer`: `has`, `get` and `put`, plus an
optional `hasMany`. Wrap it in `LayeredCache`, and a remote error is a
miss and one warning per kind of failure, naming the request, the
artifact and the layer's `endpoint` (`download <hash> from <endpoint>
failed: HTTP 500`):

```ts
import { definePlugin, defineWorkspace, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class AcmeRemote implements RemoteCacheLayer {
  constructor(readonly endpoint: string) {} // printed in warnings: no credentials in it
  async has(hash: string) {
    return (await fetch(`${this.endpoint}/${hash}`, { method: 'HEAD' })).ok
  }
  async get(hash: string) {
    const res = await fetch(`${this.endpoint}/${hash}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // a throw is a miss
    return { body: res, durationMs: undefined } // streamed to disk
  }
  async put(hash: string, body: Blob) {
    await fetch(`${this.endpoint}/${hash}`, { method: 'PUT', body })
  }
}

function acmeCache(): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline: the local cache alone
      return new LayeredCache(ctx.localCache, new AcmeRemote(`${url}/artifacts`), {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`acme-cache: ${err.message}`),
      })
    },
  })
}

export default defineWorkspace({ plugins: [acmeCache()] })
```

## What core refuses

- A `cache` or `executor` hook whose return breaks the contract: the fifteen `CacheLayer` methods, or `execute` and a `name`.
- A `name` on the hooks object: the name is the package's.
- A verb that names a core verb, or one two plugins both declare.

A sink that throws is switched off for the run, with a warning.

## Plugins that ship

| Package                     | Hooks it fills                             |
| --------------------------- | ------------------------------------------ |
| `@vzn/vx-reapi`             | `cache`, `executor` ([CI and remote](../ci/#remote-cache)) |
| `@vzn/vx-migrate`           | `project` (`turbo()`, `nx()`), `cache` (`turboCache()`, `nxCache()`) ([Migrate](../migrate/)) |
| `@vzn/vx-lockfile`          | `fingerprint`, `key` ([Lockfiles](../configure/#lockfiles)) |
| `@vzn/vx-schedule-history`  | `schedule`, `admit`, `commands`            |
| `@vzn/vx-otel`              | `telemetry` ([below](#opentelemetry))      |
| `@vzn/vx-github`            | `telemetry` ([GitHub Actions](../ci/#github-actions)) |
| `@vzn/vx-mcp`               | `commands` ([below](#vx-mcp))              |

One plugin can fill several: `@vzn/vx-schedule-history` fills three at once.

## OpenTelemetry

`@vzn/vx-otel` exports every run as OTLP traces, metrics and logs, with no
OpenTelemetry SDK: one trace per run, one span per task. Install it
(`bun add -d @vzn/vx-otel`) and point it at your collector
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`). Without an
endpoint it declines.

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

| Signal            | Carries                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `vx.run` span     | `vx.run.task_count`, `vx.run.failed_count`, `vx.run.hit_local_count`, `vx.run.hit_remote_count`, `vx.run.exit_ok`, `vx.workspace.id`, `vx.default_branch`, `vx.telemetry.schema` |
| `vx.task` span    | `vx.cache.source`, `vx.task.hash`, `vx.task.attempts`, `vx.task.blocked_by`, `vx.task.timed_out`, `vx.task.sandbox_violations`, `vx.task.not_ready` |
| metrics           | `vx.tasks.total`, `vx.tasks.failed`, `vx.tasks.cache_hits`, `vx.run.duration_ms`                          |
| a log per task    | the task's output, linked to its span; `vx.log.chars_full` says when it was cut                           |

A failed task sets its span status to `ERROR`. A failed export warns once
and names the reply; a slow collector is cut off after `timeoutMs`, and
the run still exits green.

## vx mcp

`@vzn/vx-mcp` lets Claude Code, Cursor, Continue.dev or Copilot ask your
workspace why a task re-ran, read-only, over stdio. Install it
(`npm install -D @vzn/vx-mcp`) and declare it; `vx help` then lists
`vx mcp`. Point your agent at it (`claude mcp add vx -- vx mcp`) and start
the agent inside the workspace; restart it if it lists no vx tools.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({ plugins: [mcp()] })
```

```jsonc
// ~/.claude/mcp.json; Cursor, Continue.dev and Copilot take the same shape
{ "mcpServers": { "vx": { "command": "vx", "args": ["mcp"] } } }
```

| Tool               | Answers                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `listTasks`        | What can I run here?                                             |
| `getCacheStats`    | How big is the cache, and what is today's hit rate?              |
| `getRunHistory`    | Which tasks run, how fast, how often they fail or flake?         |
| `explainCacheKey`  | What is the cache identity of `pkg#build`?                       |
| `whyDidThisRerun`  | Why did `pkg#test` re-run instead of hitting?                    |
| `getWorkspaceInfo` | What `vx info` says: versions, plugins, cache, sandbox           |

Nothing it exposes can run a task or write the cache. The server speaks
MCP in about 150 lines, with no dependencies.
