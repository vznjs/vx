---
title: Workspace configuration
description: Declare your plugins and set workspace-wide defaults in vx.workspace.ts — the file that decides what actually runs your tasks.
---

Per-package settings live in each package's `vx.config.ts`. Settings that
apply to the **whole workspace** go in `vx.workspace.ts` at the workspace
root — and so does the one thing vx will not assume for you: **which
plugins provide the executor and the cache**.

```ts
// vx.workspace.ts (at the workspace root)
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({
  plugins: [localExecutorPlugin(), localCachePlugin()],
  concurrency: 8,
  cacheDir: '.vx/cache',
})
```

`defineWorkspace` is an identity function — it's there for TypeScript
autocomplete and validation, with no runtime effect. The file is loaded
from `vx.workspace.{ts,mts,js,mjs}`.

## `plugins` — required, and deliberately so

Everything except `plugins` has a built-in default. `plugins` does not.
Core applies **nothing** by default: not a cache, not even the thing
that spawns your command. Leave the file out and the first real run
stops before any task, and tells you exactly what to paste:

```console
$ vx run build --all
vx: no vx.workspace.ts found — run `vx init` to write it with the local executor and cache, plus a vx.config.ts per package from its package.json scripts. no cache plugin declared. vx runs nothing it was not told to.
Declare the plugins in vx.workspace.ts:

  import { defineWorkspace } from '@vzn/vx'
  import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
  import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
  export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
```

That looks like ceremony for a one-machine build, and for a one-machine
build it is. It buys something real once there is more than one machine:
vx's own local executor and local cache are ordinary plugins filling the
same seams a remote cache or a remote executor fills, so no first-party
path is privileged and core never grows a special case for the default.

**Order is precedence.** A plugin listed earlier is consulted first, so
put a remote cache *before* `localCachePlugin()` if you want remote hits
consulted ahead of local ones:

```ts
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'cache.internal:443' }), localExecutorPlugin(), localCachePlugin()],
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

- **Default:** the number of CPU cores (`navigator.hardwareConcurrency`).
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
