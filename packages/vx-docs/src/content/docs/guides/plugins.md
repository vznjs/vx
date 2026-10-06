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
it, call `run()` from `@vzn/vx` on a throwaway workspace. A runnable
plugin for each of nine seams, each held by a test that runs it, is in
[`packages/vx-plugin-examples`](https://github.com/vznjs/vx/tree/main/packages/vx-plugin-examples).
`vx init --plugin <seam>` writes one, with its test, into your workspace.

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
| discover | `discover(ctx)` | which directories are projects beyond the members |
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
  discover?(ctx): { dir; name }[] // directories to make projects
  project?(config, ctx): void
  graph?(nodes, ctx): void
  key?(task, ctx): Record<string, string>
  fingerprint?: { files; affected(change, ctx) }
  schedule?(nodes, ctx): Map<string, number>
  admit?(task, ctx): boolean
  executor?(ctx): TaskExecutor | undefined
  cache?(ctx): CacheLayer | undefined
  telemetry?(ctx): TelemetrySink | TelemetrySink[] | undefined
  commands?: { [verb]: { description: string; run(argv, ctx): number | Promise<number> } }
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
import { defineWorkspace } from '@vzn/vx/config'
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
          const db = Cache.inspect(ctx.cacheDir).dbHandle() // read-only: never resets the index
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

## Where a task runs

`executor` returns a `TaskExecutor`: a `name`, an optional `accepts`
that picks its tasks, and `execute`, which runs one command and returns
its exit code and output. A task every executor declines runs here.
Stream output through `onStdout` / `onStderr`, and stop on
`req.signal`, which core aborts on Ctrl-C, an embedder's abort or the
task's `exec.timeout`: core cannot reach a process your executor spawned,
so a stop that misses the shell's children leaves them running after vx
exits. Stopped on the timeout, return a non-zero exit and the task fails
as timed out. An executor still running two seconds after the abort
(`VX_KILL_GRACE_MS`) is abandoned: core settles the task without it.

```ts
import { definePlugin, type ExecuteResult, type VxPlugin } from '@vzn/vx'

export function nice(): VxPlugin {
  return definePlugin(import.meta, {
    executor: () => ({
      name: 'nice',
      accepts: (task) => task.taskId.endsWith('#e2e'),
      async execute(req): Promise<ExecuteResult> {
        const started = performance.now()
        const child = Bun.spawn(['nice', 'sh', '-c', req.command, 'sh', ...req.forwardArgs], {
          cwd: req.cwd,
          env: { ...req.env, ...req.envDefine },
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true, // its own process group, so a stop reaches what the shell starts
        })
        const stop = () => process.kill(-child.pid, 'SIGTERM')
        req.signal?.addEventListener('abort', stop, { once: true })
        const drain = async (from: ReadableStream<Uint8Array>, to: (s: string) => void) => {
          const text = new TextDecoder()
          let all = ''
          for await (const bytes of from) {
            const s = text.decode(bytes, { stream: true })
            to(s)
            all += s
          }
          return all
        }
        const [stdout, stderr] = await Promise.all([
          drain(child.stdout, req.onStdout),
          drain(child.stderr, req.onStderr),
        ])
        const exitCode = await child.exited
        return { exitCode, durationMs: performance.now() - started, stdout, stderr, violations: [] }
      },
    }),
  })
}
```

## Your own cache

Implement core's `RemoteCacheLayer`: `has`, `get` and `put`, plus an
optional `hasMany`. Wrap it in `LayeredCache`, and a remote error is a
miss and one warning per kind of failure, naming the request, the
artifact and the layer's `endpoint` (`download <hash> from <endpoint>
failed: HTTP 500`). Core awaits every call and bounds none: a `get` that
never settles holds its task, and a `put` holds the end of the run. So
give every request a deadline; a timeout is an error, and an error is a
miss:

```ts
import { definePlugin, defineWorkspace, LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

const deadline = () => AbortSignal.timeout(30_000) // core bounds no call

class AcmeRemote implements RemoteCacheLayer {
  constructor(readonly endpoint: string) {} // printed in warnings: no credentials in it
  async has(hash: string) {
    const res = await fetch(`${this.endpoint}/${hash}`, { method: 'HEAD', signal: deadline() })
    return res.ok
  }
  async get(hash: string) {
    const res = await fetch(`${this.endpoint}/${hash}`, { signal: deadline() })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // a throw is a miss
    return { body: res, durationMs: undefined } // streamed to disk
  }
  async put(hash: string, body: Blob) {
    const res = await fetch(`${this.endpoint}/${hash}`, { method: 'PUT', body, signal: deadline() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // fetch resolves on a 500
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
- A `ctx.on` hook name core does not know: `ctx.on: unknown hook '<h>' (one of …)`.
- A `config` or `project` edit the loader would refuse from a user, checked after each plugin: `vx.workspace (after plugin '<p>'): …`; a `project` edit names the project's config file, or `<name> (no config file)`, instead.
- A verb that names a core verb, or one plugins of two packages both declare (one package's plugins are one owner; the first declared runs).
- An executor `capacity` that is not a positive integer: `plugin '<p>' returned executor '<e>' with capacity <v>: it must be a positive integer`.

An `admit` that throws, or answers a Promise (it is synchronous), is
reported once and admits from then on. A sink that throws is switched
off for the run, with a warning. So is a
`ctx.on` handler that throws or rejects: its plugin is disabled for the
run and warns once, `[vx] plugin '<p>' threw in <hook>; disabled for this run: <msg>`.

A verb that throws anything but a `UserError` fails in one line, no stack:
`plugin '<p>' failed in command '<verb>': <msg>`.

## Plugins that ship

| Package                     | Hooks it fills                             |
| --------------------------- | ------------------------------------------ |
| `@vzn/vx-reapi`             | `cache`, `executor` ([CI and remote](../ci/#remote-cache)) |
| `@vzn/vx-migrate`           | `config`, `discover`, `project`, `fingerprint` (`turbo()`, `nx()`), `cache` (`turboCache()`, `nxCache()`) ([Migrate](../migrate/)) |
| `@vzn/vx-lockfile`          | `fingerprint`, `key` ([Lockfiles](../configure/#lockfiles)), `commands` (`vx prune`) |
| `@vzn/vx-schedule-history`  | `schedule`, `admit`, `commands`            |
| `@vzn/vx-otel`              | `telemetry` ([below](#opentelemetry))      |
| `@vzn/vx-ci`            | `config`, `telemetry` ([GitHub Actions](../ci/#github-actions)) |
| `@vzn/vx-mcp`               | `commands` ([below](#vx-mcp))              |

One plugin can fill several: `@vzn/vx-schedule-history` fills three at once.

## OpenTelemetry

`@vzn/vx-otel` exports every run as OTLP traces, metrics and logs, with no
OpenTelemetry SDK: one trace per run, one span per task. Install it
(`bun add -d @vzn/vx-otel`) and point it at your collector
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`). Without any
endpoint it declines; a signal's own endpoint alone exports that signal.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [otel({ serviceName: 'my-monorepo', headers: { authorization: 'Bearer …' } })],
})
```

| Option            | Env var                                | Default                 |
| ----------------- | -------------------------------------- | ----------------------- |
| `endpoint`        | `OTEL_EXPORTER_OTLP_ENDPOINT`          | none                    |
| `tracesEndpoint`  | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`   | `<endpoint>/v1/traces`  |
| `metricsEndpoint` | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`  | `<endpoint>/v1/metrics` |
| `logsEndpoint`    | `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`     | `<endpoint>/v1/logs`    |
| `serviceName`     | `OTEL_SERVICE_NAME`                    | `vx`                    |
| `headers`         | `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,…`) | `{}`                    |
| `metrics`         | `OTEL_METRICS_EXPORTER=none` turns it off | `true`               |
| `logs`            | `OTEL_LOGS_EXPORTER=none` turns it off | `true`                  |
| `timeoutMs`       | `OTEL_EXPORTER_OTLP_TIMEOUT`           | `15000`                 |
| `compression`     | `OTEL_EXPORTER_OTLP_COMPRESSION` (and `_<SIGNAL>_`) | `'none'`   |
| `live`            | none: send each task as it ends        | `true`                  |

| Signal            | Carries                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `vx.run` span     | `vx.run.task_count`, `vx.run.failed_count`, `vx.run.aborted_count`, `vx.run.hit_local_count`, `vx.run.hit_remote_count`, `vx.run.up_to_date_count`, `vx.run.restored_local_count`, `vx.run.restored_remote_count`, `vx.run.exit_ok`, `vx.workspace.id`, `vx.default_branch`, `vx.telemetry.schema` |
| `vx.task` span    | `vx.cache.source`, `vx.cache.restored` (on a hit), `vx.task.hash`, `vx.task.attempts`, `vx.task.blocked_by`, `vx.task.timed_out`, `vx.task.sandbox_violations`, `vx.task.not_ready`, `vx.task.command`, `vx.task.flaky.*`, `vx.cache.stored_*` (on a hit), `vx.task.admission_held_ms`, `vx.task.queued_ms`, `vx.task.input_files`; links to the tasks it waited on; `vx.task.retry`, `vx.task.timeout` and `vx.sandbox.violation` events |
| a span per stage  | `startup`, `load configs`, `classify + probe`, `run graph`, … (the `VX_TIMING` stages), with `vx.stage.name` |
| metrics           | `vx.tasks.total`, `vx.tasks.failed`, `vx.tasks.cache_hits`, `vx.tasks.cache_restored`, `vx.tasks.cache_up_to_date`, `vx.run.duration_ms`, `vx.run.time_saved_ms` |
| metrics per task  | `vx.task.duration`, `vx.task.cpu_time`, `vx.task.peak_memory`, `vx.task.time_saved`, `vx.task.admission_held`, `vx.task.queued` at its end; `vx.task.cpu_usage` and `vx.task.memory` each second while it runs; each point names its span as an exemplar |
| a log per task    | the task's output at its end, linked to its span; `vx.log.chars_full` says when it was cut               |
| every resource    | `service.instance.id` (the run id), `host.name`, `host.arch`, `os.type`, `vcs.ref.head.*`, `vcs.repository.*`, `vx.workspace.path` (the workspace root in its repository), and on CI `cicd.pipeline.run.url.full`, `cicd.pipeline.name`, `vcs.change.id` (the pull request), `vx.ci.job`, `vx.ci.attempt`: one key joins a run's traces, metrics and logs |

By default each task is sent as it ends (batched, at most one send a
second), and a log record as the run and each task start, so a dashboard
follows a CI run while it runs; the run span follows at the end.
`live: false` sends it all at the end. A send never holds a task, and one
a collector never answers is cut at the end-of-run deadline.

A failed task sets its span status to `ERROR`. A failed export warns once
and names the reply; a slow collector is cut off after `timeoutMs`, and
the run still exits green.

To see it on your machine, run
[otel-desktop-viewer](https://github.com/CtrlSpice/otel-desktop-viewer), a
single binary that shows traces, metrics and logs:

```sh
brew tap ctrlspice/otel-desktop-viewer
brew install --cask otel-desktop-viewer
otel-desktop-viewer
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 vx run build --all
```

## vx mcp

`@vzn/vx-mcp` lets Claude Code, Cursor, Continue.dev or Copilot ask your
workspace why a task re-ran, read-only, over stdio. Install it
(`npm install -D @vzn/vx-mcp`) and declare it; `vx help` then lists
`vx mcp`. Point your agent at it (`claude mcp add vx -- vx mcp`) and start
the agent inside the workspace; restart it if it lists no vx tools.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({ plugins: [mcp()] })
```

```jsonc
// .mcp.json at the workspace root; Cursor, Continue.dev and Copilot take the same shape
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
MCP in about 230 lines, with no dependencies.
