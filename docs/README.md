# `@vzn/vx` — technical documentation

This directory is the complete technical reference for `@vzn/vx`. Read
it to understand _what_ and _why_; read the source under `src/` to
understand _how_. Every doc is intended to be self-contained enough
that a fresh contributor (or an AI agent) can pick up development
without back-channel context.

## What `@vzn/vx` is

A content-addressed cache + task scheduler for pnpm / npm / yarn / Bun
workspaces. Authors write a per-package `vx.config.ts`; the CLI
discovers projects, builds a task graph from declared `dependsOn`,
hashes every task's inputs deterministically, executes tasks in
topological order with bounded parallelism, and replays stored outputs
on a cache hit. Local cache is SQLite-backed; an optional remote layer
speaks the Turborepo `/v8/artifacts/` HTTP wire so any Turbo-compatible
cache server works.

It is shaped most directly after Turborepo (per-package config, opt-in
caching, content-addressed key, hashes cascade through the dep graph),
with a smaller surface and three deliberate divergences:

- **TypeScript config** (`vx.config.ts`) instead of `turbo.json`.
  Presets are plain TypeScript helpers; computed values participate in
  the cache key automatically.
- **Resolved-config hash.** The cache key sees the post-evaluation
  config object, so imports and `process.env`-derived values get
  folded in. Turbo and Nx hash the static config file and miss them.
- **Strict output ownership.** Declared `cache.outputs.files` are
  wiped before exec AND before cache restore, so the project dir ends
  every run bit-identical to the cached snapshot. Turbo / Nx restore
  additively; stale files from a prior build can survive a cache hit.

Things vx intentionally is _not_, and the rationale:

- _Not_ an executor framework — no plugin protocol, no JS-function
  tasks. Shell is the API. Plugins introduce versioned packages and
  runtime indirection; vx keeps the contract minimal.
- _Not_ a daemon — every `vx run` is a fresh process. Re-discovery
  - config evaluation is fast enough on a Bun runtime that a daemon
    is not worth its operational cost.
- _Not_ a scaffolding tool, generator, watcher, or TUI. Those are
  separate problems with separate tools.
- _Not_ a non-JS runner. Rust / .NET / Gradle projects use their
  own runners; vx is a JS-monorepo runner specifically.

A complete side-by-side with Turborepo, Nx, and vite-task — including
every known gap — lives in [`comparison.md`](./comparison.md).

## Where to start

| You want to…                        | Read                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| Understand the overall shape        | [`architecture.md`](./architecture.md)                |
| Author a `vx.config.ts`             | [`schema.md`](./schema.md)                            |
| Reason about caching                | [`caching.md`](./caching.md)                          |
| Trace what `vx run` actually does   | [`execution.md`](./execution.md)                      |
| See each scenario as a diagram      | [`flows.md`](./flows.md)                              |
| See every perf decision + invariant | [`optimizations.md`](./optimizations.md)              |
| Use the CLI from a shell            | [`cli.md`](./cli.md)                                  |
| Compare to Turbo / Nx / vite-task   | [`comparison.md`](./comparison.md)                    |
| See what we share with Turbo / Nx   | [`patterns.md`](./patterns.md)                        |
| See how fast vx is vs Turbo / Nx    | [`benchmarks.md`](./benchmarks.md)                    |
| Modify, fork, or replace a module   | [`modules/`](./modules/) (one file per source module) |
| Read forward-looking design notes   | [`design/`](./design/)                                |

If you have ten minutes: read `architecture.md` then `caching.md`.
Those two cover ~80% of the system.

## Repository layout

`@vzn/vx` is a single-package project. All source lives under `src/`,
organised as eight modules — each a directory whose `index.ts` is the
module contract; cross-module imports go through it only, enforced by
`tests/module-boundaries.test.ts` (see
[`architecture.md`](./architecture.md)). Every source file has a
corresponding page under [`modules/`](./modules/). Tests live under
`tests/`, one file per source module.

The cache subsystem is more than one file: `cache/cache.ts` is the
local SQLite-backed store (v18 key derivation, tar.zst artifacts);
`cache/remote-cache.ts` is the Turbo HTTP client;
`cache/layered-cache.ts` composes the two behind the same `CacheLayer`
interface that the orchestrator consumes — local and remote transport
identical artifact bytes, so there is no separate pack/unpack bridge.

```
src/
  bin.ts                          # shebang entrypoint; forwards process.argv → cli run
  index.ts                        # public package façade (re-exports only)
  version.ts                      # the VERSION constant (cycle-free leaf)
  config.ts                       # public schema: ProjectConfig, TaskConfig, …
  cli/
    index.ts                      # module contract: argv → subcommand dispatcher + test re-exports
    run.ts                        # `vx run` parser + handler
    watch.ts                      # `vx watch` — re-run on FS change
    cache.ts                      # `vx cache prune` (and the duration / size parsers)
    help.ts                       # `vx help` text
    format.ts                     # shared formatters (formatBytes, …)
    plan-format.ts                # plan → text / JSON / Graphviz DOT
  orchestrator/
    index.ts                      # module contract: run, planRun, options/plan types, Logger
    run.ts                        # run() + planRun(): workspace → graph → schedule
    options.ts                    # RunOptions / RunSummary declarations
    prepare.ts                    # shared run/planRun setup (discover → load → graph → cache)
    plan.ts                       # `--dry` / `--graph` — predict outcomes, no exec
    execute-task.ts               # per-task: hash → cache lookup → spawn → save
    task-hash.ts                  # cache-key derivation (computeTaskHash & co.)
    upstream.ts                   # filter upstream cache hashes per inputs.tasks
    remote-cache-setup.ts         # VX_REMOTE_CACHE_* env → LayeredCache wrap
    logger.ts                     # default logger (framed blocks, summary, etc.)
    framed-output.ts              # ┌─ task ─┐ output format
    colors.ts                     # ANSI truecolor with NO_COLOR / FORCE_COLOR gating
    summary.ts                    # tail summary lines (Tasks / Cached / Time)
    tally.ts                      # shared outcome tally (summary + summarize JSON)
    run-artifacts.ts              # --summarize JSON + --profile Chrome-trace writers
  workspace/
    index.ts                      # module contract
    workspace.ts                  # findWorkspaceRoot, listProjects, resolveCacheDir, ProjectEntry
    project-loader.ts             # Bun-native vx.config.* + vx.workspace.* loader
    package-graph.ts              # workspace dep graph
    nested-dirs.ts                # project-boundary computation for input globs
    fingerprint.ts                # workspace-fingerprint (lockfiles + workspace yaml)
    filter.ts                     # pnpm-style filter DSL (`--filter`)
    affected.ts                   # git-relative project selection (`--affected`)
  graph/
    index.ts                      # module contract
    task-graph.ts                 # TaskNode DAG builder + cycle detection
    scheduler.ts                  # parallel topological executor
    dependency-spec.ts            # shared parser for dependsOn / inputs.tasks micro-syntax
  cache/
    index.ts                      # module contract
    cache.ts                      # local cache (bun:sqlite + tar.zst artifacts)
    layered-cache.ts              # local + remote composition (read-through, write-through)
    remote-cache.ts               # Turbo /v8/artifacts/ HTTP client
    inputs.ts                     # input/output glob resolution + boundary enforcement
    tar.ts                        # tar pack/extract primitives (module-internal)
  exec/
    index.ts                      # module contract
    runner.ts                     # Bun.spawn wrapper + shellQuote + runPersistent
    env.ts                        # child-env composition + essential allowlist
    sandbox-runtime.ts            # opt-in SRT sandbox (runSandboxed + violations)
  util/
    index.ts                      # module contract
    paths.ts                      # tiny POSIX-path normalizer for stable cache keys
    hash.ts                       # xxHash3 helpers (cache-key hashing)
    ulid.ts                       # run-id generator (Bun.randomUUIDv7 wrapper)
    errors.ts                     # UserError — clean stack-less error reporting

bench/
  generate.ts                     # synthetic-workspace generator
  run.ts                          # cold/warm benchmark runner (vx vs Turbo vs Nx)

docs/
  README.md                       # this file
  architecture.md                 # module map + data flow + design principles
  schema.md                       # every config field
  caching.md                      # cache key, invalidation table, layout, version history
  execution.md                    # the lifecycle of a `vx run`
  cli.md                          # CLI reference (flags, output, exit codes, env)
  comparison.md                   # side-by-side with Turbo / Nx / vite-task
  modules/README.md               # index of per-module docs
  modules/<name>.md               # one per src module
  design/                         # forward-looking proposals + historical design notes
```

## Versioned guarantees

- **Schema.** `src/config.ts` is the public surface. Breaking changes
  to the exported `ProjectConfig` / `WorkspaceConfig` / `TaskConfig`
  types are breaking changes for users.
- **Cache.** The on-disk cache is versioned via the `CACHE_VERSION`
  constant in `src/cache/cache.ts`. Bumping it orphans every
  previously-stored entry — pre-alpha tolerates this freely. See
  [`caching.md` § Bumping CACHE_VERSION](./caching.md#bumping-cache_version)
  for when a bump is required.
- **SQLite schema.** `SCHEMA_VERSION` in `src/cache/cache.ts`.
  Mismatch wipes the `entries` and `runs` tables (no migrations in
  pre-alpha).
- **Remote-cache wire.** Verbatim Turbo `/v8/artifacts/` — see
  [`design/remote-cache.md`](./design/remote-cache.md).
- **Module boundaries.** Each module's `index.ts` is its contract;
  cross-module imports of anything else fail
  `tests/module-boundaries.test.ts`. Every src file has a
  docs/modules/ page listing its public exports. Internal helpers are
  not part of the contract and can change without notice.

## Out of scope (by design)

These are deliberate non-features. Don't add them without a design pass:

- **Daemon / persistent project-graph process.** (`vx watch` exists,
  but it is a plain re-run loop, not a daemon.)
- **Generators / scaffolding.**
- **Executor / plugin protocol**, JS-function tasks.
- **TUI / interactive panes** beyond the framed-block stream output.
- **`.env` file loading.**
- **Workspace-level `globalInputs` / `globalEnv`** (a stub exists in
  the `WorkspaceConfig` future-fields list in
  [`schema.md`](./schema.md); not implemented).
- **Symlink-aware input traversal.** `Bun.Glob` walks the real tree.
- **Cross-platform shell quirks** beyond what `Bun.spawn` with
  `shell: true` gives you for free (Windows is unsupported).
- **HMAC artifact signing + pre-signed URLs** on the remote cache —
  workstream open, see [`design/remote-cache.md`](./design/remote-cache.md).

The complete list of features Turbo / Nx / vite-task have that vx
doesn't (deliberately or otherwise) is in
[`comparison.md`](./comparison.md).

## A note on Bun

vx assumes Bun ≥ 1.3. We rely directly on:

- `bun:sqlite` (cache metadata + run history)
- `Bun.spawn` (`resourceUsage()` for cpu_ms + peak RSS)
- `Bun.file` / `Bun.write` (stream I/O)
- `Bun.Glob` (input/output resolution)
- `Bun.hash.xxHash3` (cache-key + file-content hashing)
- `Bun.YAML` (`pnpm-workspace.yaml` parse)
- Native `await import()` of `.ts` (vx.config.ts loader; no jiti)

There is no Node fallback path. `bun install` produces a `bun.lock`;
TypeScript source ships as-is — `src/bin.ts` runs via shebang.
