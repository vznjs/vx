---
title: 'Every task has a key now'
date: 2026-10-21T18:00:00Z
authors:
  - vzn
tags:
  - caching
  - design
excerpt: 'A cached build behind an uncached code generator could replay a stale result when the generator''s env changed. Why vx moved inputs out of the cache block and onto the task, so every task is keyed whether it caches or not, and how a gitignored file can now be an input.'
---

A cache key is only as good as what it can see. Until 0.0.640, vx put a
task's `inputs` inside its `cache` block. A task that did not cache had
nowhere to say what it read, so vx keyed it on its whole project and its
env names, never their values.

That left a hole one task downstream. Take a code generator you do not
cache, because it is fast, and a build you do:

```ts title="app/vx.config.ts"
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    codegen: {
      exec: {
        command: 'mkdir -p gen && echo "export const api = \"$API_URL\"" > gen/api.ts',
        env: { passThrough: ['API_URL'] },
      },
      inputs: { files: ['schema.json', '.env.local'], env: ['API_URL'] },
    },
    build: {
      dependsOn: ['codegen'],
      exec: { command: 'mkdir -p dist && cat gen/api.ts > dist/app.js' },
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: ['dist/**'] } },
    },
  },
})
```

The build folds its dependency's key. When that key held only env names,
changing `API_URL` changed nothing the build could see, and the next run
replayed a `dist/` built against the old URL. A green run, wrong bytes.

## Inputs belong to the task

`inputs` now sits on the task, beside `exec`, and keys the task whether
it caches or not. Turbo and Nx hash every task too. `cache` holds only
what caching adds: `outputs` and `inputStability`.

Change `API_URL` and the build misses, and `vx why` names the reason:

```sh frame="terminal"
$ vx why app#build
  verdict    cache key changed: upstream app#codegen

  what changed (1 component, 3 unchanged):
    changed upstream  app#codegen  4b7de2010949e4d2 → 7236b1cdcdf0fb7d

  what to do:
    upstream  a dependency's key moved; `vx why app#codegen` says why
```

A task with a command and no `inputs` has no key at all. vx does not
guess one. Every task that depends on it misses and saves nothing, so a
missing declaration costs a re-run, never a stale hit:

```sh frame="terminal"
$ vx run build --all
 ⏺︎     6ms success no-cache app#codegen
 ⏺︎     5ms success miss     app#build
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 1∅ · 1 not saved
```

A group with `inputs` and no `exec` is keyed too, and the
[configure guide](../../guides/configure/#caching) has every rule.

## A gitignored file can be an input

The generator above reads `.env.local`, which git ignores. vx keys
tracked files from git's own index, so an ignored file used to be
invisible, and a task could not name it at all.

Now a path named outright (`.env.local`), or a glob whose fixed part git
ignores (`gen/**`), is read from disk and hashed. A broad glob like
`src/**` still skips what git ignores, and `node_modules` is never
walked. Edit `.env.local` and the generator's key moves, and the build's
with it.

`--affected` still follows only what git sees, as Nx does: an ignored
input never selects a task on its own, but its key still moves when the
task runs.

## The upgrade

Both changes were breaking. `tasks.<name>.cache.inputs` became
`tasks.<name>.inputs`, a `cache` block needs an `exec`, and the lock
went to version 4. vx is pre-1.0, so there is no alias: move the field
and run `vx lock`.

The full key, part by part, is in [Caching](../../caching/). More on vx
at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
