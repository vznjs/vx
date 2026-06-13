---
title: Workspace configuration
description: Set workspace-wide defaults in vx.workspace.ts — task concurrency and the cache directory location.
---

Per-package settings live in each package's `vx.config.ts`. A few settings
apply to the **whole workspace** — those go in an optional
`vx.workspace.ts` at the workspace root. The file is entirely optional;
every field falls back to a built-in default when it's absent.

```ts
// vx.workspace.ts (at the workspace root)
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  concurrency: 8,
  cacheDir: '.vx/cache',
})
```

`defineWorkspace` is an identity function — it's there for TypeScript
autocomplete and validation, with no runtime effect. The file is loaded
from `vx.workspace.{ts,mts,js,mjs}`.

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
