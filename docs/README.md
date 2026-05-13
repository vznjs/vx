# `@vzn/vx` — technical documentation

This directory is the complete technical reference for `@vzn/vx`. Read
it instead of the source when you want to understand _what_ and _why_;
read the source when you want to understand _how_.

## What `@vzn/vx` is

A monorepo task runner for pnpm / npm / yarn / Bun workspaces. You
author a `vx.config.ts` per package; you run `vx run <task>` at the
workspace root; the tool discovers projects, builds a task graph from
declared dependencies, executes tasks in topological order with
parallelism, and caches each task's outputs and replays them on cache
hit. Local cache is SQLite-backed; an optional remote layer speaks the
Turborepo `/v8/artifacts/` wire.

It is shaped most directly after Turborepo (per-package config, opt-in
caching, content-addressed key, cache hashes cascade through the
dependency graph). It diverges from Turbo in three notable ways:

- **TypeScript config** (`vx.config.ts`) instead of `turbo.json` —
  presets and computed values are first-class.
- **Resolved task config hash** folded into the cache key — config
  imports, computed values, and partial reconfigurations are captured
  automatically because the hash sees the post-evaluation object.
- **Strict output ownership.** Declared `cache.outputs.files` are
  cleaned before exec AND before restore, so the project dir ends a
  cached run bit-identical to the snapshot.

It is intentionally _not_ an executor framework (no plugin protocol,
no JS-function tasks), _not_ a generator, _not_ a daemon. Commands are
shell strings; everything else is layered on top.

A side-by-side feature comparison with Turborepo, Nx, and vite-task
(plus the gaps) lives in [`comparison.md`](./comparison.md).

## Where to start

| You want to…                        | Read                                   |
| ----------------------------------- | -------------------------------------- |
| Understand the overall shape        | [`architecture.md`](./architecture.md) |
| Author a config                     | [`schema.md`](./schema.md)             |
| Reason about caching                | [`caching.md`](./caching.md)           |
| Trace what happens at `vx run` time | [`execution.md`](./execution.md)       |
| Use the CLI                         | [`cli.md`](./cli.md)                   |
| Compare to Turbo / Nx / vite-task   | [`comparison.md`](./comparison.md)     |
| Modify or replace a specific module | [`modules/`](./modules/)               |
| Read forward-looking design notes   | [`design/`](./design/)                 |

## Repository layout

`@vzn/vx` is a single-package project. All code lives under `src/`;
each module has a corresponding page in [`modules/`](./modules/).

The remote-cache, layered-cache, and cache-archive modules each have
their own page under [`modules/`](./modules/) — that's where the
per-module contract lives.

## Versioned guarantees

- The schema in `src/config.ts` is the public contract. Breaking
  changes there are breaking changes for users.
- The cache schema is versioned by a `CACHE_VERSION` constant in
  `src/cache.ts`. Bumping it invalidates every previously-stored
  entry.
- Internal module boundaries are documented under [`modules/`](./modules/);
  replacements just need to honor the public functions / types listed
  in each module's doc.

## Out of scope (by design)

The following intentionally don't exist and shouldn't be added without
a deliberate design pass:

- Watch mode, daemon, persistent tasks
- Generators / scaffolding
- Executor / plugin protocol — _no JS-function tasks_
- `affected --base` (git-relative selection)
- TUI / interactive panes (the framed-block stream output is final)
- `.env` file loading
- Workspace-level `globalInputs` / `globalEnv` (deferred; see
  [`schema.md`](./schema.md))
- Symlink-aware input traversal
- Cross-platform shell quirks beyond what `Bun.spawn` with `shell:
true` gives you for free

The complete list of features Turborepo / Nx / vite-task have and `vx`
doesn't (deliberately or otherwise) is in
[`comparison.md`](./comparison.md).
