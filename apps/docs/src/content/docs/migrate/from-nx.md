---
title: Migrate from Nx
description: Move from Nx to vx — drop the daemon, the plugins, and the executors, keep the affected graph and the speed. How vx migrate reads your Nx project graph.
---

Leaving Nx means trading a large, plugin-driven platform for a small,
explicit tool. You keep the parts you actually relied on — caching, the
task graph, `affected` — and shed the daemon, the executor plugins, and
the generators. This guide covers the mapping and the honest
trade-offs.

## The core mental shift: executors → shell commands

This is the one real difference. Nx targets run through **executors**
(`@nx/js:tsc`, `@nx/vite:build`, …) — plugins that wrap a tool behind a
JSON options object. vx has no executors. **A task is a shell command.**

So an Nx target like:

```jsonc
{ "build": { "executor": "@nx/js:tsc", "options": { "main": "src/index.ts", "tsConfig": "tsconfig.lib.json" } } }
```

becomes the command that executor would have run:

```ts
build: {
  exec: { command: 'tsc -b tsconfig.lib.json' },
  cache: { inputs: { files: ['src/**', 'tsconfig.lib.json'] }, outputs: { files: ['dist/**'] } },
}
```

This is more explicit and more portable — the command is right there, no
plugin indirection — but it does mean executor-backed targets need a real
command. `vx migrate` leaves a `TODO(vx-migrate)` placeholder where it
can't infer one, so nothing is silently wrong.

## Let `vx migrate` do the mechanical part

`vx migrate` reads Nx's **resolved project graph** (the source of truth,
including plugin-inferred targets) rather than guessing from `nx.json`:

```bash
# generate the resolved graph Nx uses internally
nx graph --file=.nx/workspace-data/project-graph.json

curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
vx migrate --dry        # preview generated vx.config.ts files + report
vx migrate              # write them (won't overwrite without --force)
```

If only `nx.json` is present (no resolved graph), `vx migrate` tells you
to run the `nx graph` command above — it won't guess at plugin-inferred
targets. The generated configs freeze that resolved snapshot as static
config; review them, replace executor placeholders with the real
commands, and fill the TODOs.

## What maps directly

| Nx                                   | vx                                              |
| ------------------------------------ | ----------------------------------------------- |
| a project's `targets`                | `tasks`                                          |
| target `dependsOn` (`^build`, etc.)  | `dependsOn` — same `'build'` / `'^build'` syntax |
| `inputs` / `namedInputs` (resolved)  | `cache.inputs.files`                            |
| `{workspaceRoot}/file` inputs        | `cache.inputs.workspaceFiles`                   |
| `outputs`                            | `cache.outputs.files`                           |
| `nx affected`                        | `vx run <task> --affected`                      |
| `nx run-many --target=build`         | `vx run build --all`                            |
| `nx build app`                       | `vx run app#build`                              |
| local + Nx Cloud cache               | local + remote cache (Turborepo wire)           |

`namedInputs` (Nx's reusable input sets) don't have a schema equivalent
in vx — but because the config is TypeScript, you express the same thing
with a shared array you import and spread. `vx migrate` resolves them
inline for you.

## What you gain

- **No daemon.** Nothing running in the background, no `nx reset` when the
  graph goes stale, no socket state to corrupt. vx's warm, cached runs
  are several times faster than Nx's in the repo's head-to-head benchmark
  (`bun bench/compare.ts`, results in [Benchmarks](../../benchmarks/)).
- **No plugin graph to maintain.** No `@nx/*` packages to keep in sync
  with your tools. When a tool changes, you change a string.
- **Caching that's stricter.** Resolved-config hashing (your imports and
  computed values are in the cache key) and outputs wiped before every
  restore (no stale files survive) — neither of which Nx does.
- **A tiny surface.** One binary, shell commands, TypeScript config. The
  whole model fits in your head in an afternoon.

## What you give up (be honest)

vx is deliberately not a platform. If your repo leans on these, weigh the
move carefully:

- **Generators / scaffolding** (`nx generate`) — vx has none. Use the
  tools' own scaffolding, or a separate generator.
- **Executor plugins and their option schemas** — replaced by shell
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
| `nx affected -t test`         | `vx run test --affected`    |
| `nx run app:build --verbose`  | `vx run app#build --verbosity 2`       |
| `nx graph`                    | `vx run build --graph`      |
| `nx reset`                    | *(no daemon — nothing to reset)* |

## Next steps

- **[Quickstart](../../quickstart/)** — confirm a cached run works.
- **[Configuring tasks](../../guides/tasks/)** — turn executors into
  commands.
- **[vx vs Turborepo vs Nx](../../comparison/)** — the full, sourced
  comparison.
