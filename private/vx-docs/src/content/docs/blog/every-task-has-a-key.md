---
title: 'Every task has a key'
date: 2026-10-21T18:00:00Z
authors:
  - vzn
tags:
  - caching
  - design
excerpt: 'Inputs sit on the task, not in the cache block, so a task is keyed whether it caches or not. A cached build behind an uncached code generator misses when the generator''s env changes, and a gitignored file can be an input.'
---

A code generator you don't cache, and a build you do:

```ts title="packages/e/vx.config.ts"
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

```sh frame="terminal"
$ API_URL=https://a.example vx run packages/e#build
  cache     local 1✓ 1∅

$ API_URL=https://b.example vx run packages/e#build
  cache     local 1∅ 1↑
$ cat packages/e/dist/app.js
export const api = https://b.example

$ vx why packages/e#build
  verdict    cache key changed: upstream packages/e#codegen
  what changed (1 component, 3 unchanged):
    changed upstream  packages/e#codegen  35dfe1115aedc6d6 → a7a53dc4d9e0bde9
```

`codegen` never caches (`∅`), yet it has a key, and `build` folds it.
A new `API_URL` re-runs the build instead of replaying a `dist/` built
for the old one. Demo workspace, vx at `69617eb`, 2026-10-23.

## Inputs belong to the task

`inputs` sits on the task, beside `exec`, and keys it whether it caches
or not. Turbo and Nx hash every task too. `cache` holds only what
caching adds: `outputs` and `inputStability`.

A task with a command and no `inputs` has no key. vx doesn't guess
one. Every task that depends on it misses and saves nothing:

```sh frame="terminal"
$ vx run packages/e#build      # codegen without inputs
  cache     local 1∅ · 1 not saved
$ vx run packages/e#build
  cache     local 1∅ · 1 not saved
```

A missing declaration costs a re-run, never a stale hit. A group with
`inputs` and no `exec` is keyed too; the
[Caching](../../docs/caching/) page has every rule.

## A gitignored file can be an input

`.env.local` above is gitignored, and editing it still moves the key:

```sh frame="terminal"
$ echo "TOKEN=2" > packages/e/.env.local
$ vx run packages/e#build
  cache     local 1∅ 1↑
```

vx keys tracked files from git's index. A path named outright
(`.env.local`), or a glob whose fixed part git ignores (`gen/**`), is
read from disk and hashed. A broad glob like `src/**` still skips what
git ignores, and `node_modules` is never walked.

`--affected` follows only what git sees, as Nx does: an ignored input
never selects a task on its own, but its key still moves when the task
runs.

The full key, part by part: [Caching](../../caching/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
