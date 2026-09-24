---
title: Writing a vx plugin
description: A plugin fills one or more stages of every run — the tasks a project has, the cache key, the order, where a task runs, where artifacts live, where run records go — from one object in vx.workspace.ts.
---

Change every run from one place: add tasks, key material, a cache, an
exporter or a CLI verb. Why plugins? →
[Chapter 9: How vx is built](../../guide/inside-vx/)

## Steps

1. Write a function that returns `definePlugin(import.meta, hooks)`. Its name is its package's name.
2. Fill only the hooks you need (below). An unfilled hook costs nothing.
3. Declare it in `vx.workspace.ts`: `plugins: [typecheck()]`. Plugins are asked in that order.
4. Run `vx info`: it lists each plugin and its hooks.
5. Test it: call `run()` from `@vzn/vx` on a throwaway workspace and read what your hooks saw.

## Config

A plugin that gives every TypeScript package a `typecheck` task:

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

What every plugin declines runs and is stored on this machine.

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

## Adding a verb

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

## The telemetry sink

A sink gets each run's summary. Do network I/O in `flush()`, which vx
awaits for up to 3 s.

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

Implement core's `RemoteCacheLayer` (`has`, `get`, `put`, optional
`hasMany`) and wrap it in `LayeredCache`. A remote error is then a miss:

```ts
import { definePlugin, defineWorkspace, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class AcmeRemote implements RemoteCacheLayer {
  constructor(private url: string) {}
  async has(hash: string) {
    return (await fetch(`${this.url}/artifacts/${hash}`, { method: 'HEAD' })).ok
  }
  async get(hash: string) {
    const res = await fetch(`${this.url}/artifacts/${hash}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`) // a throw is a miss
    return { body: res, durationMs: undefined } // streamed to disk
  }
  async put(hash: string, body: Blob) {
    await fetch(`${this.url}/artifacts/${hash}`, { method: 'PUT', body })
  }
}

function acmeCache(): VxPlugin {
  return definePlugin(import.meta, {
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline: the local cache alone
      return new LayeredCache(ctx.localCache, new AcmeRemote(url), { policy: ctx.policy })
    },
  })
}

export default defineWorkspace({ plugins: [acmeCache()] })
```

## Plugins that ship

| Package                     | Hooks it fills                             |
| --------------------------- | ------------------------------------------ |
| `@vzn/vx-reapi`             | `cache`, `executor`                        |
| `@vzn/vx-migrate`           | `project` (`turbo()`, `nx()`), `cache` (`turboCache()`, `nxCache()`) |
| `@vzn/vx-lockfile`          | `fingerprint`, `key`                       |
| `@vzn/vx-schedule-history`  | `schedule`, `admit`, `commands`            |
| `@vzn/vx-otel`              | `telemetry`                                |
| `@vzn/vx-github`            | `telemetry`                                |
| `@vzn/vx-mcp`               | `commands`                                 |

One plugin can fill several: `@vzn/vx-schedule-history` fills three at once.

## What core refuses

- A `cache` or `executor` hook whose return breaks the contract: the fifteen `CacheLayer` methods, or `execute` and a `name`.
- A `name` on the hooks object: the name is the package's.
- A verb that names a core verb, or one two plugins both declare.

A sink that throws is switched off for the run, with a warning.
