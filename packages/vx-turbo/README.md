# @vzn/vx-turbo

Run a Turbo repository under [`@vzn/vx`](https://github.com/vznjs/vx) with nothing written: the plugin fills vx's `project` stage from `turbo.json` and each package's `package.json` scripts, using the same mapper `vx migrate --from turbo` renders files from. What runs is what a migration would have written, minus the file — a trial that commits nothing. Zero dependencies.

## Usage

```ts
// vx.workspace.ts — the only file vx needs
import { defineWorkspace } from '@vzn/vx'
import { turbo } from '@vzn/vx-turbo'

export default defineWorkspace({ plugins: [turbo()] })
```

Then `vx run build --all` runs every package's `build` script the way `turbo run build` would: `dependsOn` edges (`^build`, same-package deps, `pkg#task`), `inputs` / `outputs` as the cache block, `env` / `passThroughEnv`, `cache: false`, `persistent`. Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`) are inlined into every task; per-package `turbo.json` overlays apply.

## Locking

`vx lock` freezes the evaluation of written `vx.config.*` files only.
A package that has none gets its tasks from `turbo.json` on every
load — under `--frozen` too — so the lock records nothing for it and
`vx lock --check` does not audit it; `turbo.json` is its source of
truth, committed like one.

## What it does not do

- A task the package's own `vx.config` already declares is left alone — the plugin fills, it never overwrites. Migrate a package by writing its config; the rest of the repo keeps running from `turbo.json`.
- The mapping's gaps are the migration's gaps, reported as warnings on every run instead of `TODO(vx-migrate)` comments: `$TURBO_ROOT$` tasks, wildcard env names, negated outputs, unknown turbo keys. `bunx @vzn/vx-migrate --dry` lists the same set once. Each gap is one line per run for every task that carries it, not one per task (n8n marks `dev` and `watch` persistent in most of its 84 packages; astro negates `vendor/**` in the outputs of 57 tasks). A per-package `{ "extends": false }` with nothing else is Turbo's opt-out and maps to no task; with keys, the task runs on those keys alone. A glob that climbs out of the package (`../../packages/app-store/*.generated.ts`) is re-anchored on the workspace root as a `workspaceFiles` glob. A negated output under a literal-rooted one (`dist/**` minus `!dist/**/*.map`) is a todo and the positive glob stays; one against a wildcard-rooted output (medusa's `*/**` minus `!src/**`) makes the task uncached, because the clean before exec would otherwise delete the sources — declare the exact outputs in a vx.config to cache it.
- Nothing is cached, run or resolved differently from a written config: the key a task derives here equals the key the written config would derive. The cost is the stage's: on a 1,000-package workspace with no `vx.config` files the mapping loads in about 42 ms where 1,000 evaluated configs load in 22, in a run that is otherwise the same ~200 ms warm.
- The mapping is read once per run, never once per process: under `vx watch`, a `package.json` script edit or a per-package `turbo.json` overlay edit is the next cycle's tasks. The root `turbo.json` is no task's input and lives in no project dir, so an edit to it is not a cycle — restart the watch.

## Options

| Option | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| `root` | Directory holding `turbo.json`. Defaults to the workspace root. |

## The mapper (`mapTurboWorkspace`)

The plugin exports the mapping it runs live, so a tool that renders it to
files reads a repo the same way: `@vzn/vx-migrate` writes `vx.config.ts`
per package from it, splicing Turbo's global fields in as imports of a
generated `vx-preset.ts`, where this plugin inlines the values. `splice`
is the seam between the two consumers; `uses` names which globals a task
drew on. Before 2026-09-10 the mapper lived in `@vzn/vx` itself.

### Rules

- **A task exists for a package only when the package declares the
  script** — Turbo's own rule. An absent script is silent; a script
  key whose value cannot be a command (a number, `null`, an empty
  string, an array) produces a `task: null` entry whose todo says why,
  rather than a config that fails to load.
- **Definition order**: root `name`, then root `pkg#name`, then the
  package's own `turbo.json` — later overlays win field by field.
- `dependsOn`: `^x` passes through; `pkg#task` is kept only when `pkg`
  emits `task` (else a todo: edge dropped); a same-package name the
  package lacks simply has no edge; `$TURBO_ROOT$` deps are a todo (vx
  has no workspace-root tasks, and root `//#` tasks become a note).
- `inputs`: absent → `**/*` (Turbo's default); `$TURBO_DEFAULT$` →
  `**/*`; `$TURBO_ROOT$/<path>` → `cache.inputs.workspaceFiles`
  (negation kept); any other `$TURBO_ROOT$` use is a todo.
  `globalDependencies` land in `workspaceFiles` too.
- `outputs`: `$TURBO_ROOT$/<path>` → `cache.outputs.workspaceFiles`;
  a negated output is a todo (vx outputs have no negation).
- `env` / `passThroughEnv`: explicit names go to `cache.inputs.env`
  (env only) and `exec.env.passThrough` (both, plus both globals); a
  wildcard is a todo. A name both a global list and the task's own
  list carry is listed once.
- `cache: false` or `persistent: true` → no `cache` block; a
  persistent task gets `exec.persistent: {}` and the consumer's
  `persistentTodo`.
- `outputLogs: "new-only"` maps to nothing: frames for the tasks that
  ran and a one-liner per cache hit is vx's default flow already. The
  other values are per-run in vx, so they are a todo naming the flag
  (`vx run … --output-logs hash-only`).
- An unknown Turbo key is a todo naming it; `extends` is accepted and
  ignored (the overlay order above is what it means).
