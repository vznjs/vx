---
title: Remote caching
description: Share cache results between machines with a cache plugin — @vzn/vx-reapi for any Bazel REAPI server, turboCache() or nxCache() for a Turbo or Nx cache, or your own.
---

Let CI and your team reuse what another machine already built. Why? →
[Chapter 8: Many machines](../../guide/many-machines/)

The local cache needs no setup; a shared one is a plugin.

## Steps

1. Pick a server: any Bazel REAPI server, a Turborepo cache, or an Nx cache.
2. Install its plugin and declare it in `vx.workspace.ts` (below).
3. Give it the endpoint, inline or from the environment (`VX_REAPI_ENDPOINT`).
4. Run anything. vx looks locally, then asks the remote, and uploads new results in the background.
5. On a fresh clone, `vx run build --all --dry` predicts remote hits.

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.example.com:443' })],
})
```

## The first-party shared cache

`@vzn/vx-reapi` speaks Bazel's Remote Execution API: NativeLink,
BuildBuddy, Buildbarn and bazel-remote all work. It can also
[run tasks](../remote-execution/) on their workers.

## A hosted cache in three commands

`turboCache()` from `@vzn/vx-migrate` speaks Turborepo's `/v8/artifacts`
wire, which Vercel's Remote Cache serves:

```sh
bun add -d @vzn/vx-migrate
npx turbo login && npx turbo link        # stores a token and a team
export TURBO_TOKEN=… TURBO_TEAM=…        # the plugin reads Turbo's variables
```

Then declare `plugins: [turboCache()]`. `nxCache()` does the same for a
self-hosted Nx cache.

## Your own backend

Implement core's `RemoteCacheLayer` seam, `has`, `get` and `put` plus an
optional `hasMany`, and wrap it in `LayeredCache`:
[Writing a plugin](../plugins/#your-own-cache).

## Artifact integrity

`@vzn/vx-reapi` re-hashes every blob it reads. A corrupt or truncated
download is a miss, never wrong bytes.

## Common problems

- **The remote is down.** A 500, a timeout, a refused token or a corrupt artifact is a miss; the run goes on.
- **The plugin does nothing.** With no endpoint it declines. Check the job's environment.
- **A laptop should read, never write.** Run with `--cache=local:rw,remote:r`.
