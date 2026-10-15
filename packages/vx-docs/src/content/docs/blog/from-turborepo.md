---
title: 'Moving to vx from Turborepo: one command to native config'
date: 2026-09-10T23:32:00Z
authors:
  - vzn
tags:
  - migration
  - turborepo
excerpt: "Moving a Turborepo workspace to vx: `vx init` writes the native TypeScript configs beside turbo.json, and `--keep` checks the mapping first if you want it."
---

vx is shaped like Turborepo on purpose. Same per-package model, same
`dependsOn` micro-syntax (`'build'`, `'^build'`, `'pkg#build'`), same
`--filter` DSL, same `--affected`. The migration is easy because
almost nothing has to change in how you think about the graph; what
changes is where the config lives and what it can say.

## One command

`npx @vzn/vx init` beside `turbo.json` is the whole adoption. It reads
the root pipeline and any per-package `extends`, inlines the matching
`package.json` script as the task's command, and writes one
`vx.config.ts` per package, a `.vx/workspace.ts` declaring your
lockfile's plugin, and `.vx/projects.lock.json`. It installs vx with
your own package manager and never overwrites a file without `--force`:

```bash
npx @vzn/vx init              # native vx.config.ts files, .vx/workspace.ts, the lock
npx @vzn/vx run build --all   # what turbo run build did, under vx's cache
```

A task goes where the script exists, and to a package without it that
another package's `^` task reaches: a cached `true` with no outputs,
Turbo's no-op node, so an edit there still re-keys its dependants.
Anything it cannot infer becomes a `TODO(vx-migrate)` comment, never a
silently wrong value. Review those, and once `vx run build --all` does
what `turbo run build` did, delete `turbo.json`.

## Check the mapping first

`npx @vzn/vx init --keep` writes only a `.vx/workspace.ts` that runs
`turbo.json` unchanged through `turbo()` from `@vzn/vx-migrate`,
installs what it imports, and prints a `next:` line that builds once:

```ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { turbo } from '@vzn/vx-migrate'
import { npm } from '@vzn/vx-lockfile'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default {
  plugins: [
    turbo(),
    npm(),
    scheduleHistoryPlugin(),
  ],
} satisfies WorkspaceConfig
```

It is a check, not a way to keep `turbo.json`: vx's benchmarks measure
only native config. `bunx @vzn/vx-migrate --dry` then previews the
files, and `bunx @vzn/vx-migrate` writes them and drops `turbo()`. It
renders from the same mapper `turbo()` runs, so the files say exactly
what the plugin was already doing.

## What maps, and what is better

| `turbo.json`                                   | `vx.config.ts`                                          |
| ---------------------------------------------- | ------------------------------------------------------- |
| `tasks` / `pipeline`                           | `tasks`                                                 |
| `dependsOn`                                    | `dependsOn`, identical syntax                           |
| `inputs` / `outputs`                           | `cache.inputs.files` / `cache.outputs.files`            |
| `env`                                          | `cache.inputs.env` **and** `exec.env.passThrough`       |
| `passThroughEnv`                               | `exec.env.passThrough`                                  |
| `cache: false`                                 | omit the `cache` block                                  |
| `persistent: true`                             | `exec.persistent: {}`, with a TODO to set `readyWhen` when a task depends on it |
| `with` | `dependsOn` a persistent sidecar, started beside the task |
| `interactive: true` | `exec.interactive: true`: the task gets the terminal, alone |
| `extends`                                      | a package task merges over the root's; `false` alone opts out, `false` + keys runs on those alone |
| `interruptible` | nothing: `vx watch` keeps a persistent task up and restarts it only when its config changes or it dies |
| `tags` | nothing: labels Turbo keeps out of the hash and the behaviour |
| `outputLogs` (Turbo 1: `outputMode`)           | no per-task knob: the per-run `--output-logs` flag      |
| `$TURBO_ROOT$/file`                            | `cache.inputs.workspaceFiles`                           |
| `dotEnv` (Turbo 1)                              | `cache.inputs.runtime`: a probe that hashes the `.env` files |
| `command` (Turbo 2.11) | the task's `exec.command`; `null` is no task |
| `description` | the task's `description` |
| `globalDependencies`, `globalEnv`, `globalPassThroughEnv`, `globalDotEnv` | a generated `vx-preset.ts` you import and spread |

Those are every key the mapper knows. Any other key in a task becomes
a TODO naming it, so nothing is dropped silently.

Three things you get that the JSON could not give you:

- **The command is in the config.** Turborepo runs the script with the
  task's name; vx makes `exec.command` explicit. A task is one shell
  command, and you can read it where it is declared.
- **Inputs are required and explicit.** The migration writes Turbo's
  default, every file in the package, as `**/*`, where you can see and
  narrow it; the [sandbox](../the-sandbox/) can then prove them.
- **Presets are imports.** `globalDependencies` becomes a constant in a
  file every config imports, and the resolved-config hash sees it. No
  list to keep in sync.

## The deliberate divergences

- A bare task name never widens an anchored task's scope. In Turbo,
  `turbo run web#lint build` also runs `web#build`; in vx, `build`
  takes the filter scope and `web#lint` stays anchored.
- No `--parallel`. It exists in Turbo as an escape hatch for
  over-declared edges. `dependsOn` in vx is explicit; `--concurrency 1`
  serialises, and `--exclude-dependencies[=<names>]` drops edges.
- Failure propagation starts one notch further along. Turbo stops the
  run at the first failure; a vx run with no flag is `deps-ok` — a
  task runs when its own dependencies succeeded, and only its
  dependents are skipped. `--continue=never` is Turbo's default
  behaviour, and bare `--continue` is `always`, which is what bare
  `--continue` means in Turbo too.

Every other Turbo behaviour a user would reach for is pinned by a
parity case that runs vx's real CLI against the Turbo contract it
stands in for. The full guide, with before/after
configs, is [Migrate from Turborepo](../../guides/migrate/#turborepo).
