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

```ts
type Plugin = {
  readonly name: string                          // 'org/plugin-name'
  setup(ctx: PluginContext): void | Promise<void>
}

type PluginContext = {
  readonly workspaceRoot: string
  readonly cacheDir: string
  readonly bus: EventBus                          // raw event stream
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
}
```

Available hooks (call from inside `setup`):

| Hook | Fires when | Args |
| --- | --- | --- |
| `onRunStart` | The run begins | `(info: { total, concurrency, requestedCount })` |
| `onTaskStart` | A task starts executing | `(node: TaskNode)` |
| `onTaskStdout` | A task emits a stdout chunk | `(node, chunk)` |
| `onTaskStderr` | A task emits a stderr chunk | `(node, chunk)` |
| `onTaskComplete` | A task ends in any terminal state | `(node, outcome: TaskOutcome)` |
| `onRunStatus` | A run-level status line is printed | `(line: string)` |
| `onRunEnd` | The run finishes | `()` |

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
