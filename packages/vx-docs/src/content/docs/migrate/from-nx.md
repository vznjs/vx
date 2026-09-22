---
title: Migrate from Nx
description: Run an Nx repo under vx unchanged with `nx()`, then move off — drop the daemon and the plugins at your pace, keep the affected graph and the speed. How `bunx @vzn/vx-migrate` reads your Nx project graph.
---

Leaving Nx means trading a large, plugin-driven platform for a small,
explicit tool. You keep the parts you actually relied on — caching, the
task graph, `affected` — and shed the daemon, the executor plugins, and
the generators. This guide covers the mapping and the honest
trade-offs.

## Try it first: run the repo unchanged

Nothing has to be written to find out. `nx()` from `@vzn/vx-migrate`
fills vx's `project` stage from Nx's **resolved** project graph — the one
Nx has already applied `targetDefaults`, `namedInputs`, plugin-inferred
targets and `{projectRoot}` tokens to — so every project's targets are
vx tasks, with their inputs, outputs and `dependsOn`:

```ts
// vx.workspace.ts — the only file
import { defineWorkspace } from '@vzn/vx'
import { nx } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [nx()] })
```

```bash
vx run build --all      # what `nx run-many -t build` ran, under vx's cache
```

Executor targets keep running as executors: each becomes an `nx-exec`
line (`nx-exec @nx/js:tsc --project lib --target build --options '{…}'`)
that runs the executor in its own Node process through Nx's public
`runExecutor`, with the options on the command line so vx's key sees
them. `nx:run-commands` targets run as the shell they are. The plugin
refreshes its graph snapshot when `nx.json` or a `project.json` changes,
by running `nx graph --file` once; a warm vx run never runs Nx at all.

## The mental shift, when you migrate: executors → shell commands

Nx targets run through **executors** (`@nx/js:tsc`, `@nx/vite:build`, …)
— plugins that wrap a tool behind a JSON options object. vx has no
executors. **A task is a shell command.** `nx-exec` is the bridge: an
executor target migrates as the line that runs it, so nothing is a
placeholder and the repo runs on day one. Then, target by target, an
`nx-exec` line becomes the command the executor was wrapping:

```jsonc
{ "build": { "executor": "@nx/js:tsc", "options": { "main": "src/index.ts", "tsConfig": "tsconfig.lib.json" } } }
```

```ts
// what bunx @vzn/vx-migrate writes — runs unchanged, keyed on the options
build: {
  exec: { command: `nx-exec @nx/js:tsc --project lib --target build --options '{"main":"src/index.ts","tsConfig":"tsconfig.lib.json"}'` },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}

// what you replace it with when the target leaves Nx
build: {
  exec: { command: 'tsc -b tsconfig.lib.json' },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}
```

The second form is more explicit and more portable — the command is right
there, no plugin indirection, no `nx` in `devDependencies` — and it is
yours to write at your pace. Keep `nx` and `@vzn/vx-migrate` installed for
as long as a config carries an `nx-exec` line.

## Let `@vzn/vx-migrate` do the mechanical part

`bunx @vzn/vx-migrate` reads Nx's **resolved project graph** (the source of truth,
including plugin-inferred targets) rather than guessing from `nx.json`:

```bash
# generate the resolved graph Nx uses internally
nx graph --file=.nx/workspace-data/project-graph.json

bun add -d @vzn/vx
bunx @vzn/vx-migrate --dry   # preview generated vx.config.ts files + report
bunx @vzn/vx-migrate         # write them (won't overwrite without --force)
```

If only `nx.json` is present (no resolved graph), `bunx @vzn/vx-migrate` tells you
to run the `nx graph` command above — it won't guess at plugin-inferred
targets. The generated configs freeze that resolved snapshot as static
config; review them, replace `nx-exec` lines with bare commands when you
are ready, and fill the TODOs.

## What maps directly

| Nx                                   | vx                                              |
| ------------------------------------ | ----------------------------------------------- |
| a project's `targets`                | `tasks`                                          |
| target `dependsOn` (`^build`, etc.)  | `dependsOn` — `'build'` and `'^build'` are the same syntax; Nx's `project:target` becomes vx's `project#target` (a configuration suffix has no vx equivalent and is dropped with a TODO) |
| `inputs` / `namedInputs` (resolved)  | `cache.inputs.files`                            |
| `{workspaceRoot}/file` inputs        | `cache.inputs.workspaceFiles`                   |
| `{ "env": "VAR" }` inputs            | `cache.inputs.env` **and** `exec.env.passThrough` (a vx task's env is isolated, so a hashed variable has to be let through too) |
| `{ "runtime": "<cmd>" }` inputs      | `cache.inputs.runtime` — vx runs the command and hashes its output, same as Nx |
| `outputs`                            | `cache.outputs.files`                           |
| `nx affected`                        | `vx run <task> --affected`                      |
| `nx run-many --target=build`         | `vx run build --all`                            |
| `nx build app`                       | `vx run app#build`                              |
| local + Nx Cloud cache               | local + a remote-cache plugin (`nxCache()` keeps a self-hosted Nx cache) |

`namedInputs` (Nx's reusable input sets) don't have a schema equivalent
in vx — but because the config is TypeScript, you express the same thing
with a shared array you import and spread. `bunx @vzn/vx-migrate` resolves them
inline for you.

## What you gain

- **No daemon.** Nothing running in the background, no `nx reset` when the
  graph goes stale, no socket state to corrupt. vx's warm, cached runs
  are several times faster than Nx's in the repo's head-to-head benchmark
  (`bun packages/vx-bench/compare.ts`, results in [Benchmarks](../../benchmarks/)).
- **No plugin graph to maintain.** No `@nx/*` packages to keep in sync
  with your tools. When a tool changes, you change a string.
- **Caching that's stricter.** Resolved-config hashing (your imports and
  computed values are in the cache key) and outputs wiped before every
  restore (no stale files survive) — neither of which Nx does.
- **A tiny surface.** One binary — no Node, no Bun — shell commands,
  TypeScript config. The whole model fits in your head in an afternoon.
- **Nx Cloud's answers, locally.** Flaky-task detection reads your own
  run history (`vx run` footer, `--summarize`, `vx info`); lockfile-aware
  hashing is `@vzn/vx-lockfile`; remote caching and remote execution are
  plugins against servers you run.

## What you give up (be honest)

vx is deliberately not a platform. If your repo leans on these, weigh the
move carefully:

- **Generators / scaffolding** (`nx generate`) — vx has none. Use the
  tools' own scaffolding, or a separate generator.
- **Executor plugins and their option schemas** — they keep running
  through `nx-exec` for as long as you want; the destination is shell
  commands you write.
- **Module-boundary / lint rules, Nx Console, the plugin ecosystem** —
  out of scope for vx.

If those are central to how your team works, Nx may be the right tool and
that's a legitimate call. vx is for teams who want fast, correct task
running and caching without the platform.

## Commands you already know

| Nx                            | vx                          |
| ----------------------------- | --------------------------- |
| `nx build app`                | `vx run app#build`          |
| `nx run-many -t build`        | `vx run build --all`        |
| `nx affected -t test`         | `vx run test --affected` (changed projects and their dependents) |
| `nx run app:build --verbose`  | `vx run app#build --verbosity 1`       |
| `nx graph`                    | `vx run build --graph`      |
| `nx reset`                    | *(no daemon — nothing to reset)* |

Every row a Nx user relies on, spelled in vx and pinned by a test, is
the [parity map](../../parity/).

## Next steps

- **[Quickstart](../../quickstart/)** — confirm a cached run works.
- **[Configuring tasks](../../guides/tasks/)** — turn executors into
  commands.
- **[vx vs Turborepo vs Nx](../../comparison/)** — the full, sourced
  comparison.
