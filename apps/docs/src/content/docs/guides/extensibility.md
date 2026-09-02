---
title: Core is provider-neutral
description: vx core is only a task runner. Where a task runs, which cache backs it, and where run data goes are all plugins — declared in vx.workspace.ts, first-party or your own. Core applies none of them by default and depends on none of them.
---

vx core is **only a task runner**. It discovers projects, builds the task
graph, hashes inputs, runs tasks in order with a local cache, and prints
the result. That's the whole product. A plain `vx run` opens no socket,
calls no service, and needs no account — it works fully offline, forever.

Everything beyond that — a **dashboard**, a **shared/remote cache**,
**remote execution**, **telemetry export** — is a **plugin**. Core
defines the extension seams; plugins fill them, and **no plugin is
privileged**: core never names one and never needs one. Core's OWN
execution and cache are plugins too (`@vzn/vx/plugins/local-executor`,
`@vzn/vx/plugins/local-cache`), declared by your workspace exactly like a
third-party one — which is how "a plugin can replace any part" is pinned
rather than promised.

## The pipeline

A run is a pipeline — discover projects, evaluate configs, build the
task graph, derive keys, schedule, execute, cache, observe — and a plugin
is a small object in `vx.workspace.ts` that hooks any of those stages.
Each hook is independent and opt-in, and declaration order is the order
everywhere. **Nothing is applied by default** — a workspace declares
every plugin it uses, including the local executor and cache; one that
declares neither fails before any task runs, naming the exact lines to
add.

```mermaid
flowchart LR
  cfg["configs"] --> proj["project()"] --> graph["graph()"] --> key["key()"] --> sched["schedule()"] --> exec["executor()"] --> cache["cache()"] --> obs["telemetry()"]
  proj -. edit tasks .-> p["plugins in vx.workspace.ts<br/>first-party OR your own"]
  exec -. where it runs .-> p
  cache -. where artifacts live .-> p
  obs -. run records out .-> p
```

| Stage    | Hook                   | What a plugin decides                                   | Declared by                          |
| -------- | ---------------------- | ------------------------------------------------------- | ------------------------------------ |
| project  | `project(config, ctx)` | a project's tasks — add, remove, rewrite (keyed like yours) | nothing unless declared          |
| graph    | `graph(nodes, ctx)`    | the run's edges                                         | nothing unless declared              |
| key      | `key(task, ctx)`       | extra cache-key material (named in `vx why`)            | nothing unless declared              |
| schedule | `schedule(nodes, ctx)` | which ready task runs first                             | `scheduleHistoryPlugin()`, or your own |
| execute  | `executor(ctx)`        | *where* ONE task's command runs — local or a worker     | `localExecutorPlugin()`, or your own |
| store    | `cache(ctx)`           | *which* cache is used — your server, S3, a CAS          | `localCachePlugin()`, or your own    |
| observe  | `telemetry(ctx)`       | *where* run data goes — OTel, Slack, your DB            | nothing unless declared              |
| cli      | `commands`             | which verbs `vx` has                                    | nothing unless declared              |

None of these can change *what* a task's command is once it is declared
— shell is the API. `project` may add or rewrite a task, and that edit
is hashed into the key exactly like a hand edit; an `executor` changes
WHERE the command runs, never the command itself; `telemetry` is
observe-only by construction (a sink holds no run handle), so it can
never change, slow, or fail a run.

See [Writing a vx plugin](/vx/guides/plugins/) for the full contract and
runnable examples.

## The first-party plugins are just plugins

`@vzn/vx-reapi` fills `cache` (and, in time, `executor`) against any
server speaking Bazel's Remote Execution API — NativeLink, BuildBuddy,
Buildbarn, bazel-remote. `@vzn/vx-otel` fills `telemetry` against any OTLP
endpoint. Both decline when unconfigured and cost nothing, so they are
safe to leave declared everywhere. Neither is privileged: they use the
same seams your own package would.

## Build your own

Because the seams are the only contract, a third-party package is a
**first-class equal** to any first-party one. To back the cache
with your own infrastructure, implement core's three-call
`RemoteCacheLayer` seam (`has`/`get`/`put` — throw on failure, and
`LayeredCache` degrades every throw to a cache miss):

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
    if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`)
    return { body: await res.arrayBuffer(), durationMs: undefined }
  }
  async put(hash: string, body: ArrayBuffer | Uint8Array) {
    await fetch(`${this.url}/artifacts/${hash}`, { method: 'PUT', body })
  }
}

function acmeCache(): VxPlugin {
  return {
    name: 'acme/cache',
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline → core uses the local cache
      return new LayeredCache(ctx.localCache, new AcmeRemote(url), {
        policy: ctx.policy,
        onRemoteError: (e) => ctx.warn(`acme cache: ${e.message}`),
      })
    },
  }
}

export default defineWorkspace({ plugins: [acmeCache()] })
```

The same pattern gives you a custom `executor` (run a task's command on
your own worker) or `telemetry` sink (ship to your own analytics).
Everything a plugin needs — `VxPlugin`, `CacheLayer`, `RemoteCacheLayer`,
`LayeredCache`, `TelemetrySink`, `TaskExecutor`, the run/graph types — is
exported from the single `@vzn/vx` entry point.

## Bring your own remote cache

The remote-cache **wire is a plugin concern** — core ships no HTTP cache
client at all. `@vzn/vx-reapi` speaks Bazel's CAS; a
**Turborepo-compatible** cache server (ducktors, Vercel hosted, …) is the
same recipe with Turbo's shapes inside the class:

```ts
import { LayeredCache, type RemoteCacheLayer, type VxPlugin } from '@vzn/vx'

class TurboRemote implements RemoteCacheLayer {
  // speak /v8/artifacts/:hash + x-artifact-* here, incl. HMAC if wanted
  constructor(private opts: { url: string; token: string }) {}
  async has(hash: string) {
    const res = await fetch(`${this.opts.url}/v8/artifacts/${hash}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`HEAD ${hash} → ${res.status}`)
    return true
  }
  async get(hash: string) {
    const res = await fetch(`${this.opts.url}/v8/artifacts/${hash}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`)
    const duration = res.headers.get('x-artifact-duration')
    return {
      body: await res.arrayBuffer(),
      durationMs: duration !== null ? Number(duration) : undefined,
    }
  }
  async put(hash: string, body: ArrayBuffer | Uint8Array, meta: { durationMs: number }) {
    const res = await fetch(`${this.opts.url}/v8/artifacts/${hash}`, {
      method: 'PUT',
      body,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/octet-stream',
        'x-artifact-duration': String(meta.durationMs),
      },
    })
    if (!res.ok) throw new Error(`PUT ${hash} → ${res.status}`)
  }
}

export function turboCache(opts: { url: string; token: string }): VxPlugin {
  return {
    name: 'acme/turbo-cache',
    cache: (ctx) =>
      new LayeredCache(ctx.localCache, new TurboRemote(opts), { policy: ctx.policy }),
  }
}
```

`LayeredCache` owns everything wire-independent — read-through with
local hydration, at-most-once in-flight deduplication, background
write-through uploads, and the never-fail contract — so a wire plugin
stays this small. Embedders that already hold a client can also inject
it per-run via `RunOptions.remoteCache` (explicit injection wins over
the plugin consult).

## The boundary is enforced

This isn't a convention you have to trust — it's checked in CI. Core
**never** imports a sibling package; that direction is asserted by
`tests/package-boundaries.test.ts` and the public API surface is
snapshot-pinned. Concretely, vx core:

- has **no** dependency on any `@vzn/vx-*` package;
- reads **no** provider environment variable and no remote-cache env
  at all — the remote cache reaches core only through the `cache`
  capability or `RunOptions.remoteCache`;
- ships **no** server, dashboard, or account logic;
- runs every task the same whichever plugins are declared.

So the dependency arrow only ever points **one way**: plugins depend on
`@vzn/vx`; `@vzn/vx` depends on nobody. Even core's own executor and cache
obey it — they import core through the public `@vzn/vx` specifier, which is
what makes "bring your own" a real, supported path.

## See also

- [Writing a vx plugin](/vx/guides/plugins/) — the capability contract + Sentry/Slack/metrics/cache examples.
- [Remote caching](/vx/guides/remote-caching/) — the `RemoteCacheLayer` seam and artifact integrity.
- [OpenTelemetry traces & metrics](/vx/guides/otel-bridge/) — a `telemetry` plugin in the wild.
