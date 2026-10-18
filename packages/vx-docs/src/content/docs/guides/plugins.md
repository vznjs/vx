---
title: Plugins
description: Write a plugin that fills one or more stages of every run, and export runs to OpenTelemetry.
---

Change every run from one place: add tasks, key material, a cache, an
exporter or a CLI verb.

## Write one

A plugin is a function that returns `definePlugin(import.meta, hooks)`.
Its name is its package's name. Fill only the hooks you need; an unfilled
hook costs nothing. Declare it in `.vx/workspace.ts`
(`plugins: [typecheck()]`), and `vx info` lists it with its hooks. To test
it, call `run()` from `@vzn/vx` on a throwaway workspace. A runnable
plugin for each of nine seams, each held by a test that runs it, is in
[`packages/vx-plugin-examples`](https://github.com/vznjs/vx/tree/main/packages/vx-plugin-examples).
`vx init --plugin <seam>` writes one, with its test, into your workspace.

This one gives every project with a `tsconfig.json` a `typecheck` task:

```ts
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function typecheck(): VxPlugin {
  return definePlugin(import.meta, {
    async project(config, ctx) {
      if (!(await Bun.file(path.join(ctx.dir, 'tsconfig.json')).exists())) return
      config.tasks ??= {}
      config.tasks['typecheck'] ??= {
        exec: { command: 'tsc --noEmit' },
        inputs: { files: ['src/**', 'tsconfig.json'] }, cache: { outputs: { files: [] } },
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
| discover | `discover(ctx)` | which directories are projects, and their edges |
| project     | `project(config, ctx)` | a project's tasks: add, remove, rewrite                   |
| graph       | `graph(nodes, ctx)`    | the run's edges                                           |
| key         | `key(task, ctx)`       | extra cache-key material, named in `vx why`               |
| fingerprint | `fingerprint`          | a root file it keys itself, such as a lockfile            |
| schedule    | `schedule(nodes, ctx)` | which ready task runs first                               |
| admit       | `admit(task, ctx)`     | whether a ready task starts now, beside what runs here    |
| execute     | `executor(ctx)`        | where one task's command runs                             |
| store       | `cache(ctx)`           | where artifacts live                                      |
| observe     | `telemetry(ctx)`       | where run records go; it can never change the run         |
| render | `output(ctx)` | who draws the terminal: a `Logger` in place of vx's own |
| setup       | `setup(ctx)`           | once per run, before the first task                       |
| cli         | `commands`             | which verbs `vx` has                                      |
| teardown    | `teardown()`           | flush and close at the end of the run                     |

```ts
import type { VxPlugin } from '@vzn/vx'

interface VxPlugin {
  readonly name: string // your package's name: definePlugin reads it
  config?(workspace, ctx): void
  discover?(ctx): { dir; name?; deps?; reach? }[] // projects and their edges
  project?(config, ctx): void
  graph?(nodes, ctx): void
  key?(task, ctx): Record<string, string>
  fingerprint?: { files; affected(change, ctx) }
  schedule?(nodes, ctx): Map<string, number>
  admit?(task, ctx): boolean
  executor?(ctx): TaskExecutor | undefined
  cache?(ctx): RemoteCacheLayer | undefined
  telemetry?(ctx): TelemetrySink | TelemetrySink[] | undefined
  output?(ctx): Logger | undefined // draw the run yourself
  commands?: { [verb]: { description: string; run(argv, ctx): number | Promise<number> } }
  setup?(ctx): void | Promise<void>
  teardown?(run?: RunReport): void | Promise<void>
}
```

## Workspace and projects

`config` edits the workspace config before vx reads it. Here, two
workers on CI:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function ciConcurrency(): VxPlugin {
  return definePlugin(import.meta, {
    config(workspace) {
      if (process.env.CI) workspace.run = { ...workspace.run, concurrency: 2 }
    },
  })
}
```

A project is a directory holding a `vx.config.ts`, which `vx lock`
finds. `discover` makes any other directory a project too, and names one
its path would name; its tasks come from a `project` hook. It runs in
`vx lock` and in every run:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function scriptsProject(): VxPlugin {
  return definePlugin(import.meta, {
    discover: () => [{ dir: 'scripts', name: 'scripts' }],
  })
}
```

An entry can also give a project edges, as directories. `deps` orders
`^build` and reaches `--filter app...` and `--affected`; `reach` only
reaches. These and `pkg#task` are the only project edges vx has (it
reads none from a `package.json`): with no plugin returning `deps`, a
`^build` is refused. An entry for an existing project needs no `name`:

```ts
discover: () => [{ dir: 'apps/web', deps: ['packages/ui'], reach: ['packages/config'] }]
```

`fingerprint` claims a root file the plugin reads. An edit to it makes
`--affected` ask `affected` which projects it touches (`undefined`: all of
them) and re-runs `vx watch`. Fold its bytes into the key with `key`:

```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function toolVersions(): VxPlugin {
  const file = '.tool-versions'
  return definePlugin(import.meta, {
    key: (_task, ctx) => ({ [file]: readFileSync(path.join(ctx.workspaceRoot, file), 'utf8') }),
    fingerprint: { files: [file], affected: () => undefined },
  })
}
```

A lockfile is claimed the same way: core keys no package file, and
[`@vzn/vx-lockfile`](../configure/#lockfiles) keys each project on its
own dependencies.

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

`schedule` ranks ready tasks. The run waits for its answer before the
first task, so answer from what is at hand; weights that need a fetch go
to `ctx.refine(weights)` when they arrive, and the tasks not yet started
re-rank. This one learns from your run history:

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default defineWorkspace({ plugins: [scheduleHistoryPlugin()] })
```

A CI runner starts with no history. With a remote cache declared, CI on
`main` writes its timings there and a fresh runner or a new branch reads
its merge-base's. Without one, `scheduleHistoryPlugin({ file: '.vx-timings.json' })`
keeps what it learned in one file your CI cache carries
([post](../../blog/ci-timings-file/)).

## Setup and teardown

`setup` runs once per run, before the first task; a throw stops the run.
`ctx.on` subscribes to the run's events (`onRunStart`, `onTaskStart`,
`onTaskStdout`, `onTaskStderr`, `onTaskComplete`, `onRunStatus`,
`onRunEnd`). `teardown` runs at the end, even on Ctrl-C:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function taskLog(): VxPlugin {
  const lines: string[] = []
  return definePlugin(import.meta, {
    setup(ctx) {
      ctx.on('onTaskComplete', (task, outcome) => {
        lines.push(`${task.id} ${outcome.status}`)
      })
    },
    teardown() {
      console.log(lines.join('\n'))
    },
  })
}
```

`ctx.cache` keeps your plugin's own small entries in the workspace's
cache: `get(name)`, `put(name, bytes)`, `has(name)`, `hasMany(names)`.
The local cache answers first, then each remote, under the run's cache
policy and scope. On a branch a read asks the branch's entry; pass
`false` as the last argument (`get(name, false)`) to read the base
branch's. Names are yours alone; an entry is written once, never
replaced, and at most 1 MiB. A failure is an empty answer, never an
error. `schedule` gets it too. `ctx.ci` and `ctx.branch` say where the
run is.

### Secrets

`ctx.secret({ key, prompt })`, on `setup` and a remote's `open`, reads
your plugin's entry `key` from the OS keychain (`Bun.secrets`, service:
your package name). Missing, and given a `prompt`, it asks on the
terminal with the input hidden and saves the answer, but only when stdin
and stderr are TTYs and the run is not on CI; never once the status line
is up. Otherwise it rejects: `isSecretUnavailable(err)` is true and
`err.reason` says why (`not-found`, `no-terminal`, `declined`,
`store-unavailable`). It reads no environment: check your option and
variable first, so the keychain is the last source. One answer per key
per run; prompts from two plugins never overlap.
`ctx.forgetSecret({ key })` deletes the entry when your server refuses
it, so the next run asks again.

```ts
import { definePlugin, isSecretUnavailable, type VxPlugin } from '@vzn/vx'

export function acme(): VxPlugin {
  let token: string | undefined
  return definePlugin(import.meta, {
    async setup(ctx) {
      token =
        process.env.ACME_TOKEN ||
        (await ctx.secret({ key: 'acme', prompt: 'Acme token: ' }).catch((err: unknown) => {
          if (!isSecretUnavailable(err)) throw err
          ctx.warn(`acme: no token (${err.reason}); set ACME_TOKEN`)
          return undefined
        }))
    },
    teardown() {
      token = undefined
    },
  })
}
```

A run that writes a remote cache (CI by default) keeps there the log of
each task that saved no entry, and, when `cache.upload.failures` covers
the run (`'ci'`, the default), a failed task's log and the files its
outputs left. Each leaves when its task ends, and the footer counts it
under `remote ↑`.
`teardown(run)` then gets the run's report: `runId`, `commit`, `ciRun`
(provider, run URL, pipeline, job), `ok`, and every task with its
`status`, `durationMs`, `key` and the `log` / `outputs` names vx kept.
`ctx.cache.getRun(name)` reads them back; the outputs are a plain tar.
vx keeps no manifest: write your own from the report with
`ctx.cache.put`, and a verb can read it all back on any machine.

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

## Draw the terminal

`output` takes the terminal for a run, as a live dashboard would. Return
a `Logger`, the object `run({ log })` takes, and it receives every line
and task chunk vx would have printed, the summary included. Return
`undefined` to leave vx's own output. The first plugin that returns one
draws the run. `ctx.isTTY` and `ctx.ci` say where it would
draw; decline off a terminal so pipes, CI and agents read what they
always did. A `Logger` that throws hands the rest of the run back to
vx's renderer, with one warning.

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function dots(): VxPlugin {
  return definePlugin(import.meta, {
    output(ctx) {
      if (!ctx.isTTY || ctx.ci) return undefined
      return {
        status: (line) => process.stdout.write(`${line}\n`),
        taskStdout: () => {},
        taskStderr: () => {},
        taskComplete: (_, outcome) => process.stdout.write(outcome.status === 'failed' ? 'F' : '.'),
      }
    },
  })
}
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
is abandoned: core settles the task without it.

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

Return core's `RemoteCacheLayer` from the `cache` hook: `has`, `get` and
`put`, plus an optional `hasMany`. Write `hasMany` only when your wire
answers many keys in one call: its presence tells core to ask it once
per run (and once for `--dry` and `--force`); without it core GETs each
key directly and asks `has` per key only for `--dry` and `--force`. An
entry is immutable: core never asks `has` before a `put`, so a `put` of
a key the remote holds must keep the stored bytes (check inside when
your server would overwrite). Each call also names the branch scope its
key belongs to (the last argument's `scope`, absent for a task's own
key), for a backend that keeps one store per branch; the key alone is
enough, so most remotes ignore it. Core owns the rest: the local cache is
asked first, then each plugin's remote in the order `plugins` lists them;
`--cache-policy`, `VX_CACHE_POLICY` and `cache.policy` gate every remote, and
the branch scope keeps a branch's writes apart. The hook's `ctx.scope` is
that scope (a name like `'acme/app:feat-x'`, `undefined` when none), so a
remote can pick a credential per scope or check a token's branch. A remote error is a miss and one
warning per kind of failure, naming the plugin, the request, the artifact
and the remote's `endpoint` (`download <hash> from <endpoint> failed: HTTP
500`). A remote cannot narrow the policy: a read-only credential pairs
with `remote:r`, and a refused upload is a warning. Core awaits every call and bounds none: a `get` that
never settles holds its task, and a `put` holds the end of the run. So
give every request a deadline; a timeout is an error, and an error is a
miss:

```ts
import { definePlugin, defineWorkspace, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

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
    if (await this.has(hash)) return // an entry is immutable; this server would overwrite
    const res = await fetch(`${this.endpoint}/${hash}`, { method: 'PUT', body, signal: deadline() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // fetch resolves on a 500
  }
}

function acmeCache(): VxPlugin {
  return definePlugin(import.meta, {
    cache() {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline: the local cache alone
      return new AcmeRemote(`${url}/artifacts`)
    },
  })
}

export default defineWorkspace({ plugins: [acmeCache()] })
```

A remote that needs a credential first adds an optional `open`, asked once per
run, before the first task and the status line, only when the policy
reads or writes that remote (never by `--dry`, `--no-cache` or
`--cache-policy=remote:`); a throw is a warning and the remote sits the
run out. `ctx.secret` there is your [keychain](#secrets).

### Signed artifacts

Core needs nothing more to make a shared cache trust its writers, not its
store. A body that errors as core streams it leaves nothing stored and the
read is a miss, so a wrapper can hash the download as it passes and fail it
at the end unless a key you trust signed it. Only main's CI holds the private
key; readers list the public one:

```ts
// signed-cache.ts
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { definePlugin, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

/** `remote`, but a download no trusted key signed is a miss, and uploads are signed. */
function signed(remote: RemoteCacheLayer, trustedPem: string, signingPem?: string): RemoteCacheLayer {
  const trusted = createPublicKey(trustedPem)
  const signer = signingPem ? createPrivateKey(signingPem) : undefined
  // The key is signed too, so a valid artifact cannot be replayed under another.
  const message = (hash: string, digest: string) => Buffer.from(`${hash}\0${digest}`)
  return {
    has: (hash) => remote.has(hash),
    async get(hash) {
      const [got, sig] = await Promise.all([remote.get(hash), remote.get(`${hash}.sig`)])
      if (got === null || sig === null) return null
      const signature = Buffer.from(await sig.body.arrayBuffer())
      const sha = createHash('sha256')
      const source = got.body instanceof Blob ? got.body.stream() : got.body.body!
      const body = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            sha.update(chunk)
            out.enqueue(chunk)
          },
          flush(out) {
            const ok = verify(null, message(hash, sha.digest('hex')), trusted, signature)
            if (!ok) out.error(new Error(`${hash}: no trusted signature`))
          },
        }),
      )
      return { body: new Response(body), durationMs: got.durationMs }
    },
    async put(hash, body, meta) {
      if (signer === undefined) return // every reader would refuse it
      const digest = createHash('sha256').update(await body.bytes()).digest('hex')
      await remote.put(hash, body, meta)
      await remote.put(`${hash}.sig`, new Blob([sign(null, message(hash, digest), signer)]), meta)
    },
  }
}

export function signedCache(remote: RemoteCacheLayer, trustedPem: string): VxPlugin {
  return definePlugin(import.meta, {
    cache: () => signed(remote, trustedPem, process.env.CACHE_SIGNING_KEY),
  })
}
```

`signedCache(new AcmeRemote(url), PUBLIC_KEY_PEM)` in `plugins`, and
`CACHE_SIGNING_KEY` (the private key's PEM) only in main's CI job. Make the
pair with `openssl genpkey -algorithm ed25519` and `openssl pkey -pubout`.
A pull request's job, or anyone who can write the bucket, can still write
bytes; no reader takes them.
`has()` passes through unchecked, so `vx run --dry` can predict a hit
that the real run turns into a miss.

## What core refuses

- A `cache` or `executor` hook whose return breaks the contract: the three `RemoteCacheLayer` methods, or `execute` and a `name`. A whole cache layer, what the hook returned before 0.0.637, is refused with the fix named.
- A `name` on the hooks object: the name is the package's.
- A `ctx.on` hook name core does not know: `ctx.on: unknown hook '<h>' (one of …)`.
- A `config` or `project` edit the loader would refuse from a user, checked after each plugin: `.vx/workspace (after plugin '<p>'): …`; a `project` edit names the project's config file, or `<name> (no config file)`, instead.
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
| [`@vzn/vx-reapi`](../../plugins/vx-reapi/)             | `cache`, `executor` ([CI and remote](../ci/#remote-cache)) |
| [`@vzn/vx-migrate`](../../plugins/vx-migrate/)           | `config`, `discover`, `project`, `fingerprint` (`turbo()`, `nx()`), `cache` (`turboCache()`, `nxCache()`) ([Migrate](../migrate/)) |
| [`@vzn/vx-lockfile`](../../plugins/vx-lockfile/)          | `discover`, `project`, `fingerprint`, `key` ([Lockfiles](../configure/#lockfiles)) |
| [`@vzn/vx-schedule-history`](../../plugins/vx-schedule-history/)  | `schedule`, `admit`, `commands`            |
| [`@vzn/vx-otel`](../../plugins/vx-otel/)              | `telemetry` ([below](#opentelemetry))      |
| [`@vzn/vx-ci`](../../plugins/vx-ci/)            | `config`, `telemetry` ([GitHub Actions](../ci/#github-actions), [GitLab CI](../ci/#gitlab-ci)) |

One plugin can fill several: `@vzn/vx-schedule-history` fills three at once.

## OpenTelemetry

`@vzn/vx-otel` exports every run as OTLP traces, metrics and logs, with no
OpenTelemetry SDK: one trace per run, one span per task. Install it
(`bun add -d @vzn/vx-otel`) and point it at your collector
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`). Without any
endpoint it declines; a signal's own endpoint alone exports that signal.

```ts
// .vx/workspace.ts
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
| `vx.run` span     | `vx.run.task_count`, `vx.run.failed_count`, `vx.run.aborted_count`, `vx.run.hit_local_count`, `vx.run.hit_remote_count`, `vx.run.up_to_date_count`, `vx.run.restored_local_count`, `vx.run.restored_remote_count`, `vx.run.exit_ok`, `vx.cache.upload.*` (remote uploads, once settled), `vx.workspace.id`, `vx.default_branch`, `vx.telemetry.schema` |
| `vx.task` span    | `vx.cache.source`, `vx.cache.restored` (on a hit), `vx.task.hash`, `vx.task.attempts`, `vx.task.blocked_by`, `vx.task.timed_out`, `vx.task.sandbox_violations`, `vx.task.not_ready`, `vx.task.command`, `vx.task.flaky.*`, `vx.cache.stored_*` (on a hit), `vx.task.admission_held_ms`, `vx.task.queued_ms`, `vx.task.input_files`, `vx.cache.miss.change_count` and `vx.cache.miss.changes` (what a miss's key changed since the last saved entry), `vx.cache.artifact_bytes`, `vx.cache.save_ms`, `vx.cache.fetch_ms`; links to the tasks it waited on; `vx.task.retry`, `vx.task.timeout` and `vx.sandbox.violation` events |
| a span per stage  | `startup`, `load configs`, `classify + probe`, `run graph`, … (the `VX_DEBUG_TIMING` stages), with `vx.stage.name` |
| metrics           | `vx.tasks.total`, `vx.tasks.failed`, `vx.tasks.cache_hits`, `vx.tasks.cache_restored`, `vx.tasks.cache_up_to_date`, `vx.run.duration_ms`, `vx.run.time_saved_ms` |
| metrics per task  | `vx.task.duration`, `vx.task.cpu_time`, `vx.task.peak_memory`, `vx.task.time_saved`, `vx.task.admission_held`, `vx.task.queued`, `vx.task.artifact_size`, `vx.task.cache_save`, `vx.task.cache_fetch` at its end; `vx.task.cpu_usage` and `vx.task.memory` each second while it runs; each point names its span as an exemplar |
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
