# `@vzn/vx` — technical documentation

vx is a **best-in-class task runner and content-addressed build cache**
for JavaScript monorepos, built Bun-native from the ground up. It runs
your task graph with maximum parallelism, caches every result by
content, and replays work it has already done — in milliseconds, with
correctness guarantees the established runners don't offer.

Every claim below is measured, reproducible (`bench/`), and recorded
with its invariant in [`optimizations.md`](./optimizations.md).

## Why vx

**Fastest warm paths in its class.** On a 100-project workspace a
fully-cached run completes in **144 ms wall-clock** — restore costs
the same as an intact tree. A 1090-package, 100-layer dense graph
(3270 tasks) runs fully cached in **0.62 s**. At 15k input files,
deriving every cache key costs **zero file reads, zero stats, zero DB
lookups** — hashes come straight from git's index.

**Smarter caching, not just faster caching.**

- **Resolved-config hashing.** Your `vx.config.ts` is evaluated, then
  hashed — imports, presets, and computed values all participate in
  cache identity. Static-file hashers miss them.
- **Strict output ownership.** Declared outputs are wiped before exec
  AND restore: the tree ends every run bit-identical to the cached
  snapshot. No stale stragglers, ever.
- **Exactness under restore.** Re-enumeration only happens when a
  downstream task's inputs can actually see a changed path — gitignore
  semantics stay byte-identical with a single git spawn per run.

**Engineered hot paths.** Bitset graph closures (exact
most-blocked-first scheduling in O(E·N/32)), one bulk git enumeration
partitioned by binary search, stat-check restore skips (warm-warm = N
stats, zero writes), in-process tar, atomic artifact publish,
single-transaction SQL, xxh3 seed-chained keys with collision-hardened
delimiters.

**Safe to trust.**

- HMAC artifact signing on the remote wire — a configured key
  hard-rejects unsigned responses; tampered artifacts degrade to
  re-execution, never break a run.
- Corrupt artifacts are validated before they go live and degrade to
  a miss.
- SIGINT/SIGTERM reap every child — no orphaned dev servers in CI.
- Persistent tasks gate downstream work on readiness (`readyWhen`)
  with a bounded wait (`exec.timeout`).
- Sandboxed tasks (opt-in, per task) fail on violation.

**Deliberately simple.** No daemon (and still faster cold than
daemon-warm competitors). Plugins change where a command runs, never
what it is — shell is the API. Eight contract modules with a dependency
matrix enforced in
CI. ~600 tests.

## Adopt it in two minutes

```bash
bun add -d @vzn/vx
# …or globally, as the prebuilt standalone binary:
npm install -g @vzn/vx
```

Drop a `vx.config.ts` next to any workspace package:

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      // Cache-input env vars must ALSO be passed through — the child
      // env is isolated, and a key that varies on a var the task
      // can't see is incoherent.
      exec: { command: 'tsc -p .', env: { passThrough: ['NODE_ENV'] } },
      cache: {
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'bun test' },
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
    dev: {
      exec: { command: 'vite', timeout: 30_000, persistent: { readyWhen: 'Local:' } },
    },
  },
})
```

Declare what runs it — core applies nothing by default (`vx migrate`
emits this file):

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
```

Run things:

```bash
vx run build                # current package (+ its dependency graph)
vx run build test --all     # every package, shared graph
vx run build --filter "@app/*"  # pnpm-style filters
vx run test --affected      # only what changed vs the base branch
vx watch dev                # re-run on file change
vx run build --dry          # predicted hits/misses, no execution
vx cache prune --older-than 7d --max-size 5gb
```

Remote caching is plugin-driven: a `cache` plugin fills core's
`RemoteCacheLayer` seam. `@vzn/vx-reapi` speaks Bazel's ActionCache + CAS,
so NativeLink / BuildBuddy / Buildbarn / bazel-remote all work; any other
store implements the same seam in a plugin.

## Feature map

| Feature                                                                                                       | Where to read                                                                          |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Task graph: `dependsOn`, `^task` (nearest-holder + sparse bridging), `pkg#task`, group tasks, multi-task runs | [`schema.md`](./schema.md), [`execution.md`](./execution.md)                           |
| Content-addressed caching: keys, invalidation table, transitive cascade, artifact format                      | [`caching.md`](./caching.md)                                                           |
| Remote cache layer (plugin-driven)                                                                            | [`caching.md`](./caching.md), [`modules/layered-cache.md`](./modules/layered-cache.md) |
| Persistent tasks (`readyWhen`) + task `timeout`                                                               | [`schema.md`](./schema.md)                                                             |
| Watch mode, filters, `--affected`, `--dry` / `--graph`, forwarding `--`                                       | [`cli.md`](./cli.md)                                                                   |
| Per-task sandboxing (fail-on-violation)                                                                       | [`schema.md`](./schema.md)                                                             |
| Run analytics (`vx stats`, `--summarize`, `--profile` Chrome traces)                                          | [`cli.md`](./cli.md)                                                                   |

## Where to start

| You want to…                               | Read                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| The pitch: differentiators + numbers       | [`differentiators.md`](./differentiators.md)                           |
| Understand the overall shape               | [`architecture.md`](./architecture.md)                                 |
| Author a `vx.config.ts`                    | [`schema.md`](./schema.md)                                             |
| Reason about caching                       | [`caching.md`](./caching.md)                                           |
| Trace what `vx run` actually does          | [`execution.md`](./execution.md)                                       |
| See each scenario as a diagram             | [`flows.md`](./flows.md)                                               |
| See every perf decision + invariant        | [`optimizations.md`](./optimizations.md)                               |
| Use the CLI from a shell                   | [`cli.md`](./cli.md)                                                   |
| Benchmarks + side-by-side vs other runners | [`benchmarks.md`](./benchmarks.md), [`comparison.md`](./comparison.md) |
| Modify, fork, or replace a module          | [`modules/`](./modules/) (one file per source module)                  |
| Read forward-looking design notes          | [`design/`](./design/)                                                 |

If you have ten minutes: read `differentiators.md`, then
`architecture.md`. Together they cover the why and the shape.

## Repository layout

`@vzn/vx` is a single-package project. All source lives under `src/`,
organised as eight modules — each a directory whose `index.ts` is the
module contract; cross-module imports go through it only, enforced by
`tests/module-boundaries.test.ts` (see
[`architecture.md`](./architecture.md)). Every source file has a
corresponding page under [`modules/`](./modules/). Tests live under
`tests/`, one file per source module.

The cache subsystem is more than one file: `cache/cache.ts` is the
local SQLite-backed store (v21 key derivation, tar.zst artifacts);
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
    layered-cache.ts              # local + remote composition + the RemoteCacheLayer seam
    inputs.ts                     # input/output glob resolution + boundary enforcement
    archive.ts                    # Bun.Archive pack/read/extract + containment (module-internal)
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
- **Remote-cache wire.** Plugin-driven; the first-party wire is the
  self-hosted platform's `/v1/cache` — see
  [`design/native-cache-wire-2026-07.md`](./design/native-cache-wire-2026-07.md).
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
- **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`.**
  Owner-rejected non-goal — TypeScript configs compose, so a shared preset
  imported and spread into each config is the mechanism (see
  [`schema.md`](./schema.md) and [`comparison.md`](./comparison.md)).
  Root-anchored file inputs are declared per task via
  `cache.inputs.workspaceFiles`.
- **Symlink-aware input traversal.** `Bun.Glob` walks the real tree.
- **Cross-platform shell quirks** beyond what `Bun.spawn` with
  `shell: true` gives you for free (Windows is unsupported).
- **A remote-cache wire client in core.** The remote cache is
  plugin-driven (`design/native-cache-wire-2026-07.md`); core keeps only
  the `RemoteCacheLayer` seam. Blob offload (pre-signed GET URLs) is
  reserved in the wire via the client's one-hop 307 follow.

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
