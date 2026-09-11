---
title: 'From Turborepo: run it as it is, then migrate at your pace'
date: 2026-09-10T23:32:00Z
authors:
  - vzn
tags:
  - migration
  - turborepo
excerpt: "A Turborepo workspace runs under vx with a two-line workspace file and no config rewritten. When you want the TypeScript configs, one command writes them, and a package that has one keeps it while the rest stay on turbo.json."
---

vx is shaped like Turborepo on purpose. Same per-package model, same
`dependsOn` micro-syntax (`'build'`, `'^build'`, `'pkg#build'`), same
`--filter` DSL, same `--affected`. The migration is easy because
almost nothing has to change in how you think about the graph; what
changes is where the config lives and what it can say.

## Step zero: do not migrate

`turbo()` from `@vzn/vx-migrate` fills vx's `project` stage from your existing
`turbo.json` and each package's scripts. One file, and the repository
runs under vx:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { turbo } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turbo()] })
```

```bash
bun add -d @vzn/vx @vzn/vx-migrate   # or npm / pnpm / yarn
vx run build --all
```

That is how solidjs/solid was [benchmarked](../honest-benchmarks/):
five packages, pnpm 9, Turbo 2.10.10 as the repo's own dependency, and
vx on top of the untouched `turbo.json`. Both tools see the same graph
and restore the same 64 output files; vx's warm restore is 66 ms to
Turbo's 127.

Whatever the mapping cannot express becomes a warning on every run,
which is the same list `bunx @vzn/vx-migrate --dry` prints once. A
package that writes its own `vx.config.ts` keeps it; the plugin fills
and never overwrites. So you can migrate one package at a time, or
never.

## Step one: let the tool write the files

```bash
bunx @vzn/vx-migrate --dry   # preview the generated files and a report
bunx @vzn/vx-migrate         # write them; never overwrites without --force
```

`@vzn/vx-migrate` is its own package so it runs before any vx file
exists. It reads the root pipeline and any per-package `extends`,
inlines the matching `package.json` script as the task's command, and
emits one `vx.config.ts` per package. It emits a task only where the
script exists. Anything it cannot infer becomes a `TODO(vx-migrate)`
comment, never a silently wrong value. It renders from the same mapper
`turbo()` runs, so the files say exactly what the plugin was
already doing.

## What maps, and what is better

| `turbo.json`                                   | `vx.config.ts`                                          |
| ---------------------------------------------- | ------------------------------------------------------- |
| `tasks` / `pipeline`                           | `tasks`                                                 |
| `dependsOn`                                    | `dependsOn`, identical syntax                           |
| `inputs` / `outputs`                           | `cache.inputs.files` / `cache.outputs.files`            |
| `env`                                          | `cache.inputs.env` **and** `exec.env.passThrough`       |
| `passThroughEnv`                               | `exec.env.passThrough`                                  |
| `cache: false`                                 | omit the `cache` block                                  |
| `persistent: true`                             | `exec.persistent: { readyWhen }`                        |
| `$TURBO_ROOT$/file`                            | `cache.inputs.workspaceFiles`                           |
| `globalDependencies`, `globalEnv`              | a generated `vx-preset.ts` you import and spread        |

Three things you get that the JSON could not give you:

- **The command is in the config.** Turborepo runs the script with the
  task's name; vx makes `exec.command` explicit. A task is one shell
  command, and you can read it where it is declared.
- **Inputs are required and explicit.** Turbo's default of every file
  in the package is gone. The migration writes the input globs it can
  see and marks the ones it cannot; the [sandbox](../the-sandbox/) can
  then prove them.
- **Presets are imports.** `globalDependencies` becomes a constant in a
  file every config imports, and the resolved-config hash sees it. No
  list to keep in sync.

## The deliberate divergences

- A bare task name never widens an anchored task's scope. In Turbo,
  `turbo run web#lint build` also runs `web#build`; in vx, `build`
  takes the filter scope and `web#lint` stays anchored.
- No `--parallel`. It exists in Turbo as an escape hatch for
  over-declared edges. `dependsOn` in vx is explicit, so the hatch is
  `--concurrency 1` to serialise and nothing to drop edges.
- `--continue` defaults to `deps-ok` (a task runs if its own
  dependencies succeeded) rather than `never`.

Every other Turbo behaviour a user would reach for is pinned by a
parity test that runs the real CLI. The full guide, with before/after
configs, is [Migrate from Turborepo](../../migrate/from-turborepo/).
