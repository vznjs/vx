---
title: Workspace configuration
description: Declare your plugins and set workspace-wide defaults in vx.workspace.ts — the optional file at the workspace root.
---

Per-package settings live in each package's `vx.config.ts`. Settings that
apply to the **whole workspace** go in `vx.workspace.ts` at the workspace
root, and so do the **plugins** — the remote cache, the remote executor,
the telemetry exporter, the extra CLI verbs.

```ts
// vx.workspace.ts (at the workspace root)
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.internal:443' })],
  concurrency: 8,
  cacheDir: '.vx/cache',
})
```

`defineWorkspace` is an identity function — it's there for TypeScript
autocomplete and validation, with no runtime effect of its own. The
running `vx` serves its own core to that import (a plugin package's
`@vzn/vx` import lands on the same copy), so it costs nothing extra
and needs no install beside the binary. The type-only form gives the
same checking with nothing to resolve, and is what `vx init` writes:

```ts
import type { WorkspaceConfig } from '@vzn/vx'
export default { plugins: [] } satisfies WorkspaceConfig
```

A workspace that declares plugins imports their packages at runtime
anyway; use whichever reads better there. The file is loaded from
`vx.workspace.{ts,mts,js,mjs}`.

## The file is optional; the floor is not a plugin

A workspace with no `vx.workspace.ts` runs and caches: every field has a
default, and running a command on this machine and storing its artifact
in `.vx/cache` are what those words mean when no plugin says otherwise.
Core applies **no plugin** by default — the local executor and the local
cache are its floor, not something you declare.

**Order is precedence.** Plugins are consulted in declaration order, and
the floor is the tail of every list: a remote cache is asked before the
local store, and a remote executor that declines a task hands it back to
this machine. There is nothing to put after your plugins:

```ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.internal:443' })],
})
```

A plugin that isn't configured **declines** and costs nothing, so it is
safe to leave one declared in every environment — `reapi()` with no
endpoint simply does not participate. See
[Writing a vx plugin](../plugins/) and
[Core is provider-neutral](../extensibility/).

## `concurrency`

The maximum number of tasks vx runs in parallel.

```ts
concurrency: 8
```

- **Default:** the number of CPU cores this process may use (`navigator.hardwareConcurrency`, capped by the cgroup CPU quota a container runs under).
- The CLI `--concurrency <n>` **overrides** this for a single run, so you
  can keep a sensible default here and dial it up or down ad hoc.

```bash
vx run build --all --concurrency 16   # this run only; wins over the config
```

Cores is the right cap for CPU-bound work (compilers); for I/O-bound task
graphs (lots of waiting on the network or disk) a higher number can
finish sooner. The scheduler never exceeds the cap — extra tasks queue.

## `cacheDir`

Where vx stores its local cache (the SQLite index + artifacts).

```ts
cacheDir: 'build/.vx-cache'
```

- **Default:** `.vx/cache`, relative to the workspace root.
- A relative path is resolved against the workspace root; an absolute
  path is used as-is.
- Every reader uses the same resolution — `vx run`, `vx cache prune`,
  `vx info` — so they never disagree about which cache to touch.

Relocate it when you want all derived files under one tree (e.g.
`build/`), or onto a faster/larger volume. Remember to add it to your
`.gitignore` (the default `.vx/` usually already is).

## `timeout`

A default per-task timeout in milliseconds — the lowest-precedence
fallback for a task that declares no `exec.timeout`.

```ts
timeout: 600_000
```

- **Default:** none. Omitted means no default timeout at all.
- **Precedence, highest first:** a task's own `exec.timeout`, then
  `--timeout <ms>` (the run flag), then the `VX_TASK_TIMEOUT` env var,
  then this.
- It is a runaway-process guard and nothing more: it is never folded
  into a cache key, and a task it kills fails and is never cached.

## `cacheRetention`

Evict from the local cache at the end of every run, by the same policy
`vx cache prune` takes as flags.

```ts
cacheRetention: { olderThan: '30d', maxSize: '10G' }
```

- **Default:** none. Omitted, the cache grows until you run
  `vx cache prune`.
- `olderThan` drops entries no run has used for that long (`30d`,
  `12h`, `90m`, `45s`); `maxSize` then evicts the least recently used
  until the cache is under that size (`10G`, `500MB`, a byte count).
  Either or both.
- It runs after the run's saves and uploads have landed, and only when
  something is due: a run with nothing to evict pays one scan of the
  cache index. An entry the run just used is never due.
- The run says what it evicted in one line (`vx: cache retention
  evicted 3 entries (1.2 GB)`). A failure is a warning, never a failed
  run, and the field is never folded into a cache key.

## What is *not* here (by design)

Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough` and
Nx-style `namedInputs` / `targetDefaults` are intentionally absent —
because the config is TypeScript, you compose shared inputs and presets
with plain imports instead. See
[Configuring tasks → Reusing config with presets](../tasks/#reusing-config-with-presets).

## Next steps

- **[Configuring tasks](../tasks/)** — per-package task config.
- **[Running & filtering tasks](../running-tasks/)** — `--concurrency` and
  the other run flags.
- **[Configuration reference](../../schema/)** — the full
  `WorkspaceConfig` type.
