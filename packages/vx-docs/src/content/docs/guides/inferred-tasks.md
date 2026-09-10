---
title: Inferred tasks
description: Declare vite(), vitest(), next(), tsc() or scripts() from @vzn/vx-infer and a package with no vx.config gets its tasks from the tools it uses.
---

A package does not have to write a `vx.config` to have tasks. With
`@vzn/vx-infer` declared, every package the workspace discovers is
visited, and each plugin looks at what the package uses — a
`vite.config`, a `vitest.config`, a `next.config`, a `tsconfig.json`,
its `package.json` scripts — and gives it the tasks that tool implies,
with a cache block that fits the tool.

A task the package declares itself always wins. The plugins fill; they
never overwrite.

## Turn it on

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { vite, vitest, tsc, scripts } from '@vzn/vx-infer'

export default defineWorkspace({
  plugins: [vite(), vitest(), tsc(), scripts()],
})
```

Order is precedence: a task the first plugin fills is not touched by a
later one. Put the tool plugins, whose tasks are cached, before
`scripts()`, whose tasks are not. `vx show` prints what each package
ended up with, and `vx why` explains any key.

## What each plugin infers

| Plugin      | Trigger                                                           | Tasks                                                                                                                                      |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `vite()`    | `vite.config.*`                                                   | `build` (cached on `src/**`, `public/**`, `index.html`, the config, `tsconfig*.json`, `.env*`; output `dist/**`), `dev`, `preview`         |
| `vitest()`  | `vitest.config.*`, or `vite.config.*` with vitest in the manifest | `test` (cached on sources and test dirs; no outputs)                                                                                       |
| `next()`    | `next.config.*`                                                   | `build` (cached on `app/**`, `pages/**`, `src/**`, `public/**`, the config, `.env*`; outputs what `.next/` holds besides its own `cache/`), `dev`, `start` |
| `tsc()`     | `tsconfig.json` and `typescript` in the manifest                  | `typecheck` (`tsc --noEmit`; cached on every TS file and `tsconfig*.json`)                                                                 |
| `scripts()` | `package.json` `scripts`                                          | one **uncached** task per script; `build` waits on `^build`; `dev`, `start`, `serve`, `watch` are persistent; lifecycle scripts are skipped |

Every inferred `build` and `test` depends on `^build`: the workspace
convention that a package's dependencies are built before it runs. The
`dev` and `preview` / `start` tasks are persistent and become ready when
the tool prints its local URL, so a task downstream of a dev server
starts when the server is up, not when it was spawned.

## Why scripts are uncached

A `package.json` script says what to run and nothing about what it
reads or writes. A cache key with guessed inputs is a stale hit waiting
to happen, and a stale hit is the one failure a task runner must never
produce. So `scripts()` runs its tasks every time, and the day a script
earns a cache, the package says so:

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    lint: {
      exec: { command: 'eslint .' },
      cache: { inputs: { files: ['src/**', '.eslintrc.*'] }, outputs: { files: [] } },
    },
  },
})
```

That declaration replaces the inferred `lint` whole; every other script
stays inferred.

## What is not inferred

- **The sandbox.** `exec.sandbox` says what a task may touch, and that
  is the package's own declaration, never a guess. An inferred task runs
  unsandboxed until the package's `vx.config` says otherwise. See
  [Sandboxing tasks](../sandboxing/).
- **Anything about a tool the package does not use.** A plugin that
  finds no trigger adds nothing and costs one stat per package.

## Next steps

- **[Configuring tasks](../tasks/)** — what a hand-written task can say.
- **[Caching tasks](../caching/)** — what a cache block must declare.
- **[Writing a vx plugin](../plugins/)** — the `project` stage these
  plugins fill.
