# `src/exec/env.ts` — child process env builder

## Purpose

Compose the env object passed to every child process. Implements the
**isolated env** policy: tasks see only the essentials allowlist plus
what the user explicitly declared.

## Public surface

```ts
export interface BuildEnvOptions {
  passThrough: readonly string[] // names → values from source
  define: Readonly<Record<string, string>> // explicit literal pairs
  source: NodeJS.ProcessEnv // typically process.env
  binPaths?: readonly string[] // prepended to PATH (project bins)
}

export function buildIsolatedEnv(opts: BuildEnvOptions): NodeJS.ProcessEnv

export const ESSENTIAL_ENV: readonly string[] // the allowlist below
export const VX_RUN_WORKSPACE_ENV = 'VX_RUN_WORKSPACE' // set on every task's env by execute-task: the workspace root
export const VX_RUN_TASK_ENV = 'VX_RUN_TASK' // and the task id — a `vx run` inside its own workspace reads them and refuses
```

## Composition

Layers, lowest to highest priority:

1. **Essential allowlist** — hard-coded set of env vars copied from
   `source` when present. The list:

   `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`,
   `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`,
   `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`.

2. **`passThrough` names** — for each name, copy its value from
   `source` if present. Missing names are skipped (not assigned to
   empty string).

3. **`define` entries** — literal `name: value` pairs, applied next so
   they override earlier layers (including `PATH` if you want, though
   most users won't).

4. **`binPaths` PATH prefix** — applied last, AFTER `define`. Each
   entry is prepended to the existing `PATH` (joined by `path.delimiter`).
   The orchestrator passes `<projectDir>/node_modules/.bin`, then
   `<workspaceRoot>/node_modules/.bin` (one entry when the root is the
   project), so local tools resolve without `npx`, and a monorepo's shared
   tooling, installed at the root, too. Never a sibling project's bin, so
   project isolation holds; the root is not a sibling.

Result: a `NodeJS.ProcessEnv` ready to pass to `Bun.spawn`.

## What this does NOT do

- Doesn't validate that names look reasonable (no `=` in names, etc.).
  Garbage in → garbage out.
- Doesn't read from `.env` files or anywhere except `source`. If you
  want `.env` support, do it at the config-author level (parse the file
  in `vx.config.ts` and feed values into `define`). Bun would load one
  into `process.env` itself; the shipped `vx` starts Bun with that off
  (`bin.md`, item 1089).
- Doesn't strip or sanitize values. Whatever's in `source[name]` is
  what the child sees.

## Why an explicit allowlist

Without the allowlist, child processes inherit the full parent env,
which:

- Makes builds non-reproducible across machines (every CI flag, every
  user-installed dotfile thing leaks in).
- Pollutes the cache key (if the user mistakenly tracks env: `*`).
- Hides what a task actually depends on.

With it, the rule is simple: a task depends on whatever its config
declares, plus enough essentials to find binaries and behave normally.

The allowlist is intentionally **not configurable** — a task declares any
extra vars it needs via `passThrough`. Workspace-level env defaults
(`globalEnv` / `globalPassThrough`) are an owner-rejected non-goal; compose
a shared `passThrough` list through a TypeScript preset instead.

## Tests

`env.test.ts` covers:

- Essentials passed from source; undeclared vars stripped.
- Essentials omitted when not present in source.
- `passThrough` names forwarded; missing names absent (not empty
  string) in result.
- `define` values applied.
- `define` overrides `passThrough`.
- `define` overrides essentials.

## Replacing this module

Adjusting policy:

- **Different essentials list** — edit `ESSENTIAL_ENV`. Bump
  `CACHE_VERSION` if you think this changes task identity (technically
  it changes what the child sees, but not the cache key directly — env
  values participate via `cache.inputs.env`, not via the essential
  list).
- **No essentials at all** — start with `{}`, only apply `passThrough`
  - `define`. Most tools won't find `PATH`; user must declare it.
    Strict reproducibility at high friction cost.
- **Layered profiles** — workspace-level + task-level merging. Build
  a different `BuildEnvOptions` upstream and feed it through; this
  module stays simple.
