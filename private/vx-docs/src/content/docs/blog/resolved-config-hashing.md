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

A `vx.config.ts` is a program. This one spreads a preset:

```ts
// packages/b/vx.config.ts
import { defineProject } from '@vzn/vx/config'
import { lib } from '../../vx-preset.ts'

export default defineProject({
  tasks: {
    ...lib({ entry: 'src/index.ts' }),
  },
})
```

Change the preset, not the config:

```sh frame="terminal"
$ sed -i 's/--outdir dist`/--outdir dist --minify`/' vx-preset.ts
$ vx lock --check
✗ vx lock --check  packages/b/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'

$ vx lock && vx run packages/b#build
  cache     local 1↑

$ vx why packages/b#build
  verdict    cache key changed: config
  what changed (1 component, 3 unchanged):
    changed config  config  59020bd1597ff7c8 → 524418371d4d83ba
```

`packages/b/vx.config.ts` didn't change a byte. Its task did, so its
key did. Demo workspace, vx at `69617eb`, 2026-10-23.

## The key sees the object

vx evaluates the config and hashes the **resolved task object**, the
thing the scheduler is about to act on. Part three of the
[key derivation](../keys-from-git/) is
`xxh3(JSON.stringify(hashableConfig(node.config)))` after the plugin
`project` stage has run — one field wide, dropping `exec.remote`,
which says where a task runs rather than what it does. Whatever a preset returned,
whatever a template literal expanded to, whatever a plugin added or
removed: all of it is in the key, because all of it is in the object.

Two properties fall out:

- **Presets are safe to share.** Edit `vx-preset.ts`, run `vx lock`,
  and every task that spread it re-keys, with no `globalDependencies`
  list to keep in sync.
- **Plugins are in the key.** `turbo()` from `@vzn/vx-migrate` fills the `project` stage
  from a `turbo.json`; the resolved tasks it produces are what gets
  hashed. A plugin cannot change a task's behaviour behind the key's
  back.

Placement is stripped before hashing. `exec.remote` says where a task
runs, which is not what it produces. `timeout`, `retries` and `description` are
folded, because a task that was allowed to run longer may have finished
where the shorter one was killed.

## Evaluate once: `vx lock`

Evaluating a program can give a different answer on another machine
or another day. So no run evaluates a config. `vx lock` evaluates every
config and writes the resolved objects to `.vx/projects.lock.json`, and
every `vx run` reads them from there with no evaluation at all. The key
hashes the object the lock holds, so the key a reviewer's run computed
is the key CI computes.

`vx lock --check` re-evaluates everything against the lock and exits
non-zero on drift, including drift a byte hash cannot see: an env value
read at eval time, an import that changed. The CI recipe is
`vx lock --check && vx run …`. That gets
[its own post](../lock-and-frozen/).

## Why not named inputs

A JSON config is data: a tool hashes the file and calls that the
config's part of the key. Turborepo's `globalDependencies` and Nx's
`namedInputs` exist because JSON can't compose. A `vx.config.ts` can: a shared input list is a
constant in a file you import, and the resolved-config hash sees the
result. Named inputs, global inputs and global env are on the
repository's rejected list for that reason, and they will stay there.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
