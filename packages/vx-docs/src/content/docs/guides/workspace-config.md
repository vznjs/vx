---
title: Workspace configuration
description: The optional vx.workspace.ts at the workspace root — the plugins, in order, and the defaults every run uses.
---

Declare plugins and set workspace-wide defaults. What plugins are →
[Chapter 9: How vx is built](../../guide/inside-vx/)

## Steps

1. Create `vx.workspace.ts` next to the root `package.json`. Without it, vx runs and caches on this machine.
2. List plugins in `plugins`. They are asked in that order; this machine is always last.
3. Set only the defaults you want to change (below).

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.internal:443' })],
  concurrency: 8,
  cacheDir: '.vx/cache',
  timeout: 600_000,
  cacheRetention: { olderThan: '30d', maxSize: '10G' },
})
```

## `concurrency`

How many tasks run at once. Default: the cores this process may use.
`--concurrency <n>` overrides it for one run.

## `cacheDir`

Where the local cache lives. Default: `.vx/cache`, from the workspace root.
Add it to `.gitignore`.

## `timeout`

A default task timeout in ms. Default: none. The first one set wins: a
task's `exec.timeout`, then `--timeout <ms>`, then `VX_TASK_TIMEOUT`, then
this. It is never in a cache key.

## `cacheRetention`

Evict from the local cache after every run: `olderThan` (`30d`, `12h`)
unused entries, then the least recently used until under `maxSize`
(`10G`, `500MB`). Default: none; `vx cache prune` does it by hand.

## Common problems

- **A plugin does nothing.** An unconfigured plugin declines and costs nothing, like `reapi()` without an endpoint.
- **You want shared inputs for every task.** There is no `globalInputs`: import a shared array into each config.
- **The cache keeps growing.** Set `cacheRetention`, or run `vx cache prune --older-than 30d`.
