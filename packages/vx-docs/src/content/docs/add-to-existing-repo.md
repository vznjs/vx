---
title: Add vx to an existing repo
description: Put vx on one package of a repo you already have, check its cache, and grow from there.
---

Start with one package and leave the rest of your tooling as it is. What
a task is → [Chapter 2: Tasks](../guide/tasks/)

## Steps

1. Install at the workspace root: `npm install -D @vzn/vx`.
2. Add a `vx.config.ts` next to one package's `package.json`, with the command its `build` script runs.
3. Run `vx run build` twice in that package. The second run is a cache hit.
4. Edit a file the build reads. `vx run build --dry` must now predict a miss.
5. Add configs to more packages. `dependsOn: ['^build']` orders them by your `package.json` dependencies.
6. Run `vx run build --all`.

## Config

```ts
// packages/ui/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'tsc -b' }, // what the "build" script already runs
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

A `vx.workspace.ts` at the root is optional. It sets defaults and declares plugins:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  concurrency: 8,            // default: the cores this process may use
  cacheDir: '.vx/cache',     // default: .vx/cache (relative to root)
})
```

## Common problems

- **A package has no `vx.config.ts`.** It has no tasks, and `^build` reaches through it to the nearest package that has one.
- **A package has nothing to build, but others depend on it.** Give it `build: { dependsOn: [] }`, so their `^build` waits on nothing.
- **You want the whole repo running first.** `turbo()` or `nx()` from `@vzn/vx-migrate` runs a [Turborepo](../migrate/from-turborepo/) or [Nx](../migrate/from-nx/) repo as it is.

Add `.vx/` to `.gitignore`: it holds the local cache.
