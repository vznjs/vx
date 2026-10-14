---
title: 'Configs are programs. Hash what they evaluate to.'
date: 2026-09-10T23:54:00Z
authors:
  - vzn
tags:
  - internals
  - caching
  - config
excerpt: "A vx.config.ts can import a preset, compute a command, read a constant from another file. The cache key sees the evaluated object, so all of that participates in the key. Static JSON tools cannot see it at all."
---

Turborepo's `turbo.json` and Nx's `project.json` are data. The tools
hash the file and call the config part of the key. That works exactly
as long as the file is the whole story.

A `vx.config.ts` is a program:

```ts
import { defineProject } from '@vzn/vx/config'
import { lib } from '../../vx-preset.ts'

export default defineProject({
  tasks: {
    ...lib({ entry: 'src/index.ts' }),
    docs: {
      exec: { command: `typedoc --out ${process.env.DOCS_OUT ?? 'docs'}` },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['docs/**'] } },
    },
  },
})
```

Hashing this file's bytes would miss every change to `vx-preset.ts`.
It would also miss the value of `DOCS_OUT`. Both change what the task
does.

## The key sees the object

vx evaluates the config and hashes the **resolved task object**, the
thing the scheduler is about to act on. Part five of the
[key derivation](../keys-from-git/) is
`xxh3(JSON.stringify(hashableConfig(node.config)))` after the plugin
`project` stage has run — one field wide, dropping `exec.remote`,
which says where a task runs rather than what it does. Whatever a preset returned,
whatever a template literal expanded to, whatever a plugin added or
removed: all of it is in the key, because all of it is in the object.

Two properties fall out:

- **Presets are safe to share.** Edit `vx-preset.ts` and every task
  that spread it re-keys, with no `globalDependencies` list to keep in
  sync.
- **Plugins are in the key.** `turbo()` from `@vzn/vx-migrate` fills the `project` stage
  from a `turbo.json`; the resolved tasks it produces are what gets
  hashed. A plugin cannot change a task's behaviour behind the key's
  back.

Placement is stripped before hashing. `exec.remote` says where a task
runs, which is not what it produces. `timeout`, `retries` and `description` are
folded, because a task that was allowed to run longer may have finished
where the shorter one was killed.

## Evaluating a program has a cost, so a run does not

Evaluating a hundred TypeScript files per run is not free, and caching
the evaluation is unsound for a program that reads the environment or
the clock. A run evaluates no config: it reads the resolved objects
from `.vx/lock.json`, and only `vx lock` evaluates them.

## Freezing the evaluation: `vx lock`

Sometimes you want the evaluation pinned rather than repeated. `vx lock`
evaluates every config now and writes the resolved objects plus a
content hash of each file to `.vx/lock.json`; `vx run --frozen` consumes
the lock with no evaluation at all, and `vx lock --check` re-evaluates
everything against it and exits non-zero on drift, including drift a
byte hash cannot see: an env value read at eval time, an import that
changed. The CI recipe is `vx lock --check && vx run … --frozen`. That
gets [its own post](../lock-and-frozen/).

## Why not named inputs

Turborepo's `globalDependencies` and Nx's `namedInputs` exist because
JSON cannot compose. A `vx.config.ts` can: a shared input list is a
constant in a file you import, and the resolved-config hash sees the
result. Named inputs, global inputs and global env are on the
repository's rejected list for that reason, and they will stay there.
