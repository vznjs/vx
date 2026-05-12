# `@vzn/run` — technical documentation

This directory is the complete technical reference for `@vzn/run`. Read
it instead of the source when you want to understand _what_ and _why_;
read the source when you want to understand _how_.

## What `@vzn/run` is

A monorepo task runner for pnpm workspaces. You author a `vzn.config.ts`
per package; you run `vzn run <task>` at the workspace root; the tool
discovers projects, builds a task graph from declared dependencies,
executes tasks in topological order with parallelism, and caches each
task's outputs and replays them on cache hit.

It is shaped most directly after Turborepo (per-package config, opt-in
caching, content-addressed key, cache hashes cascade through the
dependency graph). It diverges from Turbo in two notable ways:

- **TypeScript config** (`vzn.config.ts`) instead of `turbo.json` —
  presets and computed values are first-class.
- **Resolved task config hash** folded into the cache key — config
  imports, computed values, and partial reconfigurations are captured
  automatically because the hash sees the post-evaluation object.

It is intentionally _not_ an executor framework (no plugin protocol,
no JS-function tasks), _not_ a generator, _not_ a daemon. Commands are
shell strings; everything else is layered on top.

## Where to start

| You want to…                         | Read                                   |
| ------------------------------------ | -------------------------------------- |
| Understand the overall shape         | [`architecture.md`](./architecture.md) |
| Author a config                      | [`schema.md`](./schema.md)             |
| Reason about caching                 | [`caching.md`](./caching.md)           |
| Trace what happens at `vzn run` time | [`execution.md`](./execution.md)       |
| Use the CLI                          | [`cli.md`](./cli.md)                   |
| Modify or replace a specific module  | [`modules/`](./modules/)               |
| Read forward-looking design notes    | [`design/`](./design/)                 |

## Repository layout

`@vzn/run` is a single-package project. All code lives under `src/`;
each module has a corresponding page in [`modules/`](./modules/).

The remote-cache, layered-cache, cache-archive, and sandbox modules
each have their own page under [`modules/`](./modules/) — that's
where the per-module contract lives.

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
- TUI, progress bars, animated output
- `.env` file loading
- Workspace-level `globalInputs` / `globalEnv` (deferred; see
  [`schema.md`](./schema.md))
- Symlink-aware input traversal
- Cross-platform shell quirks beyond what `child_process.spawn` with
  `shell: true` gives you for free

## Proposed (designed, not yet implemented)

- Remote cache — see [`design/remote-cache.md`](./design/remote-cache.md).
