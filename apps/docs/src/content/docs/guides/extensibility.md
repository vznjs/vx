---
title: Core is provider-neutral
description: vx core is only a task runner. A dashboard, remote cache, distributed execution, and telemetry export are plugins — declared in vx.workspace.ts, first-party or your own. Core depends on none of them, and @vzn/vx-cloud is just one implementation you can replace.
---

vx core is **only a task runner**. It discovers projects, builds the task
graph, hashes inputs, runs tasks in order with a local cache, and prints
the result. That's the whole product. A plain `vx run` opens no socket,
calls no service, and needs no account — it works fully offline, forever.

Everything beyond that — a **dashboard**, a **shared/remote cache**,
**distributed execution**, **telemetry export** — is a **plugin**. Core
defines the extension seams; plugins fill them. `@vzn/vx-cloud` is the
*first-party* plugin, but it is **not privileged**: core never imports it,
never names it, and never needs it. You can delete it, ignore it, or
replace it with your own — core behaves identically.

## The seams

A plugin is a small object in `vx.workspace.ts` that contributes any of
three capabilities. Each is independent, opt-in, and has a built-in
default, so declaring nothing costs nothing.

```mermaid
flowchart LR
  core["vx core<br/>task runner · fully offline"]
  core -. backend .-> b(["route execution"])
  core -. cache .-> c(["shared / remote cache"])
  core -. telemetry .-> t(["export run data"])
  b --> p["plugins in vx.workspace.ts<br/>first-party OR your own"]
  c --> p
  t --> p
```

| Seam        | What a plugin swaps                              | Default if no plugin        |
| ----------- | ------------------------------------------------ | --------------------------- |
| `backend`   | *where* tasks run — local, remote, or distributed | in-process                  |
| `cache`     | *which* cache is used — your server, S3, Redis   | local cache (+ Turbo-wire env) |
| `telemetry` | *where* run data goes — OTel, Slack, your DB      | nothing exported            |

None of these can change *how* a task's command runs — shell is the API.
`telemetry` is observe-only by construction (a sink holds no run handle),
so it can never change, slow, or fail a run.

See [Writing a vx plugin](/vx/guides/plugins/) for the full contract and
runnable examples.

## `@vzn/vx-cloud` is just a plugin

The first-party cloud is one package that implements all three seams
against a `vx-cloud serve` process. Declaring it is one line:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({ plugins: [cloud()] })
```

With no connection configured, `cloud()` **declines every seam** and adds
zero overhead — so it's safe to leave declared everywhere. Point it at a
server (`vx-cloud connect` or `VX_CLOUD_URL` + `VX_CLOUD_TOKEN`) and the
same one connection lights up the remote cache, analytics ingest, and
distributed execution. It's a normal plugin — nothing more.

## Build your own

Because the seams are the only contract, a third-party package is a
**first-class equal** to `@vzn/vx-cloud`. To back the cache with your own
infrastructure, no cloud involved:

```ts
// vx.workspace.ts
import { defineWorkspace, LayeredCache, RemoteCache, type VxPlugin } from '@vzn/vx'

function acmeCache(): VxPlugin {
  return {
    name: 'acme/cache',
    cache(ctx) {
      const url = process.env.ACME_CACHE_URL
      if (!url) return undefined // decline → core uses the local cache
      return new LayeredCache(ctx.localCache, new RemoteCache({ baseUrl: url, token: '…' }), {
        policy: ctx.policy,
        onRemoteError: (e) => ctx.warn(`acme cache: ${e.message}`),
      })
    },
  }
}

export default defineWorkspace({ plugins: [acmeCache()] })
```

The same pattern gives you a custom `backend` (route to your own executor)
or `telemetry` sink (ship to your own analytics). Everything a plugin
needs — `VxPlugin`, `CacheLayer`, `LayeredCache`, `RemoteCache`,
`TelemetrySink`, `RunBackend`, the run/graph types — is exported from the
single `@vzn/vx` entry point.

## The boundary is enforced

This isn't a convention you have to trust — it's checked in CI. Core
**never** imports any service/cloud package; that direction is asserted by
`tests/package-boundaries.test.ts` and the public API surface is
snapshot-pinned. Concretely, vx core:

- has **no** dependency on `@vzn/vx-cloud` (or any `@vzn/vx-*` package);
- reads **no** `VX_CLOUD_*` variable — the only remote-cache env it honors
  is the provider-neutral, Turbo-compatible `VX_REMOTE_CACHE_*` escape
  hatch (which any Turbo-wire server satisfies);
- ships **no** server, dashboard, or account logic;
- runs every task the same whether zero plugins or ten are declared.

So the dependency arrow only ever points **one way**: plugins depend on
`@vzn/vx`; `@vzn/vx` depends on nobody. That's what keeps the cloud
optional and makes "bring your own" a real, supported path.

## See also

- [Writing a vx plugin](/vx/guides/plugins/) — the capability contract + Sentry/Slack/metrics/cache examples.
- [Remote caching](/vx/guides/remote-caching/) — the one-connection model and the Turbo-wire escape hatch.
- [Distributed CI execution](/vx/guides/distributed-ci/) — the `backend` seam at scale.
- [OpenTelemetry traces & metrics](/vx/guides/otel-bridge/) — a `telemetry` plugin in the wild.
