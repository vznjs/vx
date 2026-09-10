# @vzn/vx-infer

Inferred tasks for [`@vzn/vx`](https://github.com/vznjs/vx): a package with no `vx.config` gets its tasks from the tools it uses. One plugin per tool — `scripts()`, `vite()`, `vitest()`, `next()`, `tsc()` — each on core's `project` stage, each giving a package the tasks its tool implies with a cache block that fits the tool. A task the package declares itself always wins; the plugins fill, never overwrite. Zero dependencies.

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { vite, vitest, tsc, scripts } from '@vzn/vx-infer'

export default defineWorkspace({
  plugins: [vite(), vitest(), tsc(), scripts()],
})
```

Order is precedence: a task the first plugin fills is not touched by a later one, so put the tool plugins (cached tasks) before `scripts()` (uncached). `vx show` prints what each package ended up with.

## What each plugin infers

| Plugin      | Trigger                                                           | Tasks                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts()` | `package.json` `scripts`                                          | one **uncached** task per script; `build` gets `dependsOn: ['^build']`; `dev` / `start` / `serve` / `watch` are persistent; `pre*` / `post*` / `prepare` / `install` are skipped; `exclude: [...]` skips more                                             |
| `vite()`    | `vite.config.{ts,mts,js,mjs,cjs,cts}`                             | `build` (`vite build`; inputs `src/**`, `public/**`, `index.html`, the config, `tsconfig*.json`, `package.json`, `.env*`; output `dist/**`, or `outDir`), `dev` (persistent, ready on `Local:`), `preview` (persistent, after `build`)                    |
| `vitest()`  | `vitest.config.*`, or `vite.config.*` with vitest in the manifest | `test` (`vitest run`; inputs sources, `test/**`, `tests/**`, `__tests__/**`, the config, `tsconfig*.json`; no outputs)                                                                                                                                    |
| `next()`    | `next.config.*`                                                   | `build` (`next build`; inputs `app/**`, `pages/**`, `src/**`, `public/**`, `components/**`, `lib/**`, `styles/**`, the config, `.env*`; outputs what `.next/` holds besides Next's own `cache/`), `dev` (persistent), `start` (persistent, after `build`) |
| `tsc()`     | `tsconfig.json` and `typescript` in the manifest                  | `typecheck` (`tsc --noEmit -p tsconfig.json`; inputs every TS file and `tsconfig*.json`; no outputs); `task` and `project` options rename either                                                                                                          |

Every `build` and `test` depends on `^build`: the workspace convention that a package's dependencies are built before it runs.

## What is not inferred

- **The sandbox.** `exec.sandbox` says what a task may touch; that is the package's own declaration, never a guess. An inferred task runs unsandboxed until the package's `vx.config` says otherwise.
- **Cache blocks for scripts.** A script says what to run and nothing about what it reads or writes; a guessed key is a stale hit waiting to happen. Give the task a `cache` block in the package's `vx.config` the day it earns one — that declaration replaces the inferred task whole.
- **Anything about a tool the package does not use.** A plugin that finds no trigger adds nothing and costs a stat.

## Testing

`bun test` runs every plugin through `planRun` over config-less packages: the inferred shapes, the package's own declaration winning, a package without the tool getting nothing, `exclude`, and the plugins composing.
