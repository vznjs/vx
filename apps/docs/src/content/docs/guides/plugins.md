---
title: Writing a vx plugin
description: Hook into the run lifecycle from vx.workspace.ts. Plugins are in-process subscribers on the event bus with crash isolation per hook. Forward outcomes to Sentry, post summaries to Slack, ship metrics anywhere.
---

A plugin is a small object you register in `vx.workspace.ts` that
subscribes to lifecycle hooks during every `vx run`. Plugins observe
the run; they don't redirect it. Forward outcomes to Sentry, post
summaries to Slack, ship metrics to your timeseries DB, or just print
custom output.

## The contract

A `VxPlugin` is a plain object with a `name` and any of four optional
**capabilities** — declared in `vx.workspace.ts` via `defineWorkspace({
plugins: [...] })`. Each capability is independent and opt-in; declaring a
plugin that contributes none is zero-overhead.

```ts
import type { VxPlugin } from '@vzn/vx'

interface VxPlugin {
  readonly name: string // 'org/plugin-name'

  // BEHAVIOR capabilities — change WHAT/HOW work runs (opt-in, one wins):
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

## Hello, plugin

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  plugins: [
    {
      name: 'org/hello',
      setup(ctx) {
        ctx.on('onRunStart', (info) => {
          console.log(`[hello] starting run of ${info.total} tasks`)
        })
        ctx.on('onTaskComplete', (node, outcome) => {
          console.log(`[hello] ${node.id} → ${outcome.status} (${outcome.durationMs}ms)`)
        })
      },
    },
  ],
})
```

Run `vx run lint` and you'll see the plugin print before/after.

## A Sentry plugin (failed tasks → exceptions)

```ts
// plugins/sentry.ts
import * as Sentry from '@sentry/node'
import type { Plugin } from '@vzn/vx'

export function sentryPlugin(opts: { dsn: string }): Plugin {
  Sentry.init({ dsn: opts.dsn })
  return {
    name: 'org/sentry',
    setup(ctx) {
      ctx.on('onTaskComplete', (node, outcome) => {
        if (outcome.status !== 'failed') return
        Sentry.captureException(new Error(`vx task failed: ${node.id}`), {
          extra: { exitCode: outcome.exitCode, durationMs: outcome.durationMs },
        })
      })
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

```ts
// plugins/slack-summary.ts
import type { Plugin } from '@vzn/vx'

export function slackSummary(opts: { webhookUrl: string }): Plugin {
  let failed = 0
  let success = 0
  return {
    name: 'org/slack-summary',
    setup(ctx) {
      ctx.on('onTaskComplete', (_, outcome) => {
        if (outcome.status === 'failed') failed++
        else if (outcome.status === 'success') success++
      })
      ctx.on('onRunEnd', async () => {
        await fetch(opts.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: failed === 0 ? `:white_check_mark: vx run: ${success} passed` : `:x: vx run: ${failed} failed`,
          }),
        })
      })
    },
  }
}
```

## A metrics plugin (timeseries DB)

```ts
// plugins/timeseries.ts
import type { Plugin } from '@vzn/vx'

export function timeseriesPlugin(opts: { url: string }): Plugin {
  const buffer: Array<Record<string, unknown>> = []
  return {
    name: 'org/timeseries',
    setup(ctx) {
      ctx.on('onTaskComplete', (node, outcome) => {
        buffer.push({
          ts: Date.now(),
          project: node.projectName,
          task: node.taskName,
          status: outcome.status,
          durationMs: outcome.durationMs,
        })
      })
      ctx.on('onRunEnd', async () => {
        if (buffer.length === 0) return
        await fetch(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ points: buffer }),
        })
        buffer.length = 0
      })
    },
  }
}
```

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

- If `setup()` throws, the run aborts with a `UserError` naming
  the plugin. Configs with broken plugins fail loudly.
- If a hook handler throws, the plugin is **disabled for the rest
  of the run** and a warning prints. Other plugins keep firing;
  the run continues. (Same pattern as the safe-observer wrapping
  in the bus.)
- Hooks may return promises — vx fires them as fire-and-forget
  via `void` so a slow plugin can't block the run.

This is the rule from the architecture docs: **subscribers cannot
slow the run**. A wedged plugin loses events, never blocks producers.

## What plugins CANNOT do today

- **Skip a cache lookup** — `onCacheLookup` is reserved for a
  future API revision.
- **Register custom MCP/RPC methods** — plugins observe, they
  don't extend the inspector surface (yet).
- **Replace the terminal renderer** — the renderer is the default
  bus subscriber; plugins layer on top.

The full set of rules + future hook plans:
`docs/design/extension-protocol-2026-06.md`.

## Plumbing details

- Plugin order = config order. Deterministic.
- The bus is synchronous and order-preserving; chunks reach you in
  the same order the terminal renderer sees them.
- `ctx.bus` is the raw subscriber — register through `bus.subscribe`
  if your needs exceed the lifecycle hooks (e.g. you want raw
  `task:stdout` events without a node lookup).

Reference impl + lifecycle test:
`src/orchestrator/plugin.ts`, `tests/plugin-e2e.test.ts`.
