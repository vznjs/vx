# vx

**The fastest way to build a monorepo.**

vx runs your task graph, remembers every result, and never does the
same work twice. Fully cached runs finish in milliseconds — 76 ms
across 46 packages, 297 ms across a 476-package graph of 1,428 tasks,
where Turborepo takes 342 ms and Nx 1.38 s on the identical workspace.
Measured, reproducible, on hardware you own
([benchmarks](docs/benchmarks.md)).

One binary. No daemon. No Node. Nothing to babysit.

📖 **[Documentation site →](https://vznjs.github.io/vx/)** — guides,
architecture, caching, and the full CLI / config reference.

```sh
# From npm — ships the prebuilt standalone binary (no Bun required):
npm install -g @vzn/vx      # or: pnpm add -g @vzn/vx · bun add -g @vzn/vx
```

```ts
// vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      cache: {
        inputs: { files: ['src/**'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['build'],
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
    ci: { dependsOn: ['lint', 'test'] }, // umbrella; runs both
  },
})
```

```sh
vx run build              # cwd project + its workspace deps
vx run test --all         # every project that declares `test`
vx run ci --affected      # only what changed since origin/HEAD
vx watch lint             # re-run on file changes
vx run build --dry        # show the plan, don't execute
```

## A cache that actually understands your build

Every task runner caches. vx caches _correctly_ — and stops work
others would redo:

- **Config is code, and the cache knows it.** `vx.config.ts` is
  evaluated before hashing, so imports, presets, and computed values
  all participate in cache identity. Change a shared preset, and
  exactly the right tasks re-run.
- **Outputs are owned.** Declared outputs are wiped before every
  execution and every restore. Your tree ends each run bit-identical
  to the cached snapshot — stale files cannot exist.
- **Hashes come from git.** On a clean tree, deriving every cache key
  costs zero file reads, zero stats, zero database lookups. At
  15,000 files that's a 3.2× faster warm path.

## Speed is a design discipline

Exact bitset graph algorithms for scheduling. One bulk git
enumeration per run, partitioned by binary search. Restores that
skip extraction entirely when the tree already matches. In-process
tar (no subprocess on the hot path). Atomic artifact publishes.
Single-transaction metadata writes. Every optimization is recorded
with the invariant that keeps it valid —
[`docs/optimizations.md`](docs/optimizations.md) is the ledger, and
[`bench/`](bench/) reproduces the numbers.

## Built for trust

- **Provable cache correctness.** `vx run --verify` re-runs each
  cacheable task and byte-compares outputs (determinism);
  `--verify=inputs` sandboxes it against the declared inputs and fails
  loud naming any undeclared read (completeness). No other runner can
  prove a cache entry safe.
- **Corruption can't go live.** A remote artifact is verified against
  its content digest and validated before it enters the store
  (zstd-bomb and oversize downloads refused); bad bytes degrade to a
  cache miss, never a wrong hit and never a crash.
- **Clean exits.** SIGINT/SIGTERM reap every child process — no
  orphaned dev servers in CI.
- **Readiness you can bound.** Persistent tasks gate downstream work
  on a `readyWhen` signal; `exec.timeout` bounds any task (with
  `--timeout` / workspace defaults), `exec.retries` + `--retry` absorb
  flakes — and retried-then-passed tasks are flagged flaky.
- **Kernel-level sandboxing**, opt-in per task, that fails the build
  on violation instead of hiding it.

## Reproducible graphs, when you want them

Configs are TypeScript — powerful, but a program's output can vary
with its environment. `vx lock` freezes the fully-resolved task graph
into a committed `vx-lock.json`, pnpm-style:

```sh
vx lock                      # evaluate everything once, write vx-lock.json
vx lock --check && vx run ci --frozen     # CI: audit, then run EXACTLY that graph
```

| Command           | Evaluates configs | Uses lock                                                       |
| ----------------- | ----------------- | --------------------------------------------------------------- |
| `vx run`          | always, live      | never — local truth has no asterisks                            |
| `vx run --frozen` | never             | yes; refuses if absent or a config file changed since locking   |
| `vx lock --check` | full graph        | compares — catches env and import drift that byte hashes cannot |

Env values read at lock time are frozen by design — cache keys become
reproducible across machines. Bonus: `--frozen` runs skip config
evaluation entirely (~120 ms back per 1,000 packages). No other
runner has an equivalent.

## Everything you need, nothing to configure twice

TypeScript config with real imports · task graph with `^task`
resolution that bridges packages without the task · multi-task runs
with one shared graph · pnpm-style filters and `--affected` ·
watch mode · `--dry` / `--graph` plans · persistent dev servers ·
retries, timeouts, `--continue` modes · per-layer cache control
(`--cache=local:r,remote:`) · `vx why` explains a re-run from the
persisted input fingerprints · `vx last` replays a recorded run ·
`vx prune` cuts a Docker-ready workspace subset · `vx info`,
`--summarize`, `--profile` Chrome traces, `--report` · `vx cache prune`
with TTL and size caps · `vx migrate` from turbo.json or an Nx graph.

## A pipeline with seams — plugins decide what happens

Core is the pipeline: discover projects, evaluate configs, build the
task graph, derive keys, schedule, execute, cache, observe. Plugins
declared in `vx.workspace.ts` hook each stage, Vite-style, on one
`VxPlugin` object:

| Stage      | Hook                         | A plugin can…                                              |
| ---------- | ---------------------------- | ---------------------------------------------------------- |
| workspace  | `config(ws, ctx)`            | edit the workspace config before it is used                |
| project    | `project(config, ctx)`       | add, remove or rewrite a project's tasks (keyed like yours) |
| graph      | `graph(nodes, ctx)`          | add or drop edges, mark tasks requested                    |
| key        | `key(task, ctx)`             | fold extra material into the cache key (named in `vx why`) |
| schedule   | `schedule(nodes, ctx)`       | decide which ready task runs first                         |
| execute    | `executor(ctx)`              | decide WHERE a task's command runs (local, a REAPI worker) |
| store      | `cache(ctx)`                 | decide where artifacts live (local, a shared remote)       |
| observe    | `telemetry(ctx)` / `setup`   | receive every run record, or the raw event bus             |
| cli        | `commands`                   | add verbs to `vx`                                          |

Core applies **no plugin by default** — even its own local executor and
cache are plugins your workspace declares, which is what makes "replace
any part" real rather than promised. First-party plugins:
[`@vzn/vx-reapi`](packages/vx-reapi) (Bazel Remote Execution API —
remote cache and remote execution against NativeLink, BuildBuddy,
Buildbarn or bazel-remote), [`@vzn/vx-otel`](packages/vx-otel)
(OpenTelemetry traces + metrics + logs, zero SDK deps),
[`@vzn/vx-github`](packages/vx-github) (Actions job summary + Checks
API), [`@vzn/vx-mcp`](packages/vx-mcp) (`vx mcp` — a read-only Model
Context Protocol server for AI coding agents, no SDK), and
`@vzn/vx/plugins/schedule-history` (order by learned critical path). Nothing distributed ships in this repo; the seams are how you
build it.

## How it compares

|                           | vx                                                                    | Turborepo                      | Nx               |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------ | ---------------- |
| Fully cached, 100 pkgs¹   | **144 ms**                                                            | 279 ms                         | 583+ ms          |
| Config                    | TypeScript, evaluated into the cache key                              | JSON (static)                  | JSON (static)    |
| Output ownership          | **Strict** — wiped before exec AND restore                            | Additive (stale files survive) | Additive         |
| Clean-tree hashing        | **Zero reads** (git index OIDs)                                       | git OIDs                       | re-hash / daemon |
| Daemon required for speed | **No**                                                                | Optional                       | Yes              |
| Per-task sandbox          | **Yes** — kernel-level, opt-in                                        | No                             | No               |
| Provable cache safety     | **Yes** — `--verify` (determinism) + `--verify=inputs` (completeness) | No                             | No               |
| Plugin API                | **Yes** — executor / cache / telemetry seams                          | No                             | Yes (TS-tied)    |
| OTel CI/CD spans          | **Yes** — `otel()` plugin, zero OTel-SDK deps                         | No                             | Paid             |
| Install                   | **Single binary** — npm or 1 curl line, no Node/Bun needed            | npm + Node                     | npm + Node       |

¹ Wall-clock, direct binaries, same machine and workspace — full
methodology and more scenarios in
[`docs/benchmarks.md`](docs/benchmarks.md).

## Switching from another runner

Most projects can move in an afternoon. The mapping is mechanical:

```jsonc
// turbo.json (before)
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**"],
      "outputs": ["dist/**"],
      "env": ["NODE_ENV"],
    },
  },
}
```

```ts
// vx.config.ts (after)
import { defineProject } from '@vzn/vx'
export default defineProject({
  tasks: {
    build: {
      // Name the command (Turbo reads package.json scripts). The child
      // env is ISOLATED: a cache-input env var must also be passed
      // through, or the key would vary while the task can't see it.
      exec: { command: 'tsc -b', env: { passThrough: ['NODE_ENV'] } },
      dependsOn: ['^build'],
      cache: {
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

Differences to know:

- vx requires `exec.command` in the config — we don't read `package.json` scripts implicitly.
- vx requires `cache.inputs.files` when caching is enabled (no default `$TURBO_DEFAULT$`).
- vx defaults caching **off**; opt in per task by adding the `cache` block.
- Persistent tasks: `persistent: { readyWhen: 'regex' }` (Turbo uses just `persistent: true`).
- Remote caching is a plugin, not a built-in — connect one and every `vx run` reads through it.

Side-by-side feature matrix + every known gap: [`docs/comparison.md`](./docs/comparison.md).

## Architecture (one paragraph)

`bin.ts → cli/index.ts` dispatches subcommands.
`orchestrator/run.ts:run()` calls `prepareRun()` which discovers the
workspace, loads configs, builds the package + task graph, opens the
cache (local SQLite + an optional remote layer), and installs plugins
from `vx.workspace.ts`. The two-tier scheduler runs the graph in
topological order with bounded concurrency (confirmed cache hits
restore ahead of their deps); each task hits the cache (hash → get →
restore on hit; spawn → save on miss) or short-circuits as a group /
persistent. Every observation flows through one event bus — the
terminal renderer subscribes directly, and plugins receive the
versioned telemetry contract (`TelemetryRecord` / `RunSummaryRecord`)
— that's how telemetry and cache plugins export without core knowing
them. Core never imports a plugin; the arrow only points plugin → core.
Every module has a docs page; every interface is a swappable seam.

Read [`docs/architecture.md`](./docs/architecture.md) for the module
map; the design record lives under [`docs/design/`](./docs/design/).

## Documentation

Full technical docs live under [`docs/`](./docs/) and on the
[documentation site](https://vznjs.github.io/vx/):

- [`docs/architecture.md`](./docs/architecture.md) — module map + data flow
- [`docs/schema.md`](./docs/schema.md) — every config field
- [`docs/caching.md`](./docs/caching.md) — cache-key derivation + invalidation table
- [`docs/execution.md`](./docs/execution.md) — `vx run` lifecycle
- [`docs/cli.md`](./docs/cli.md) — every flag
- [`docs/comparison.md`](./docs/comparison.md) — Turbo / Nx / vite-task feature matrix
- [`docs/modules/`](./docs/modules/) — one reference page per source module

The design record lives under [`docs/design/`](./docs/design/); the
maintainers' handoff is [`docs/STATUS.md`](./docs/STATUS.md).

## Status

**Pre-alpha.** The schema is settling; we bump `CACHE_VERSION` rather
than maintain back-compat. **2,600+ tests; CI green on every commit**;
the project dogfoods itself (`vx run ci`). Published on npm:
[`@vzn/vx`](https://www.npmjs.com/package/@vzn/vx) (a prebuilt standalone
binary).

Production readiness for the **core task runner**: the semantics are
solid; it is dogfooded continuously. The main operational rough edge
is Windows (unsupported).

| Surface                                        | Maturity                | Notes                                                            |
| ---------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Core task runner + caching                     | **production-ready**    | dogfooded continuously; 2,600+ tests, all green                  |
| `vx run --verify` (provable cache correctness) | **shippable**           | determinism + input-completeness proofs; CI-gate recipe in docs  |
| Plugin API (executor / cache / telemetry)      | **shippable**           | crash-isolated; core's own executor + cache are ordinary plugins |
| OTel export (`@vzn/vx-otel`)                   | **shippable**           | declare `otel()` in `vx.workspace.ts`; OTLP traces + metrics     |
| REAPI remote cache (`@vzn/vx-reapi`)           | **in progress**         | Bazel ActionCache + CAS; NativeLink / BuildBuddy / Buildbarn     |

## Development

```sh
git clone https://github.com/vznjs/vx && cd vx
bun install
bun src/bin.ts run ci          # format-check + lint + test
bun src/bin.ts run build       # cross-target binaries → dist/
```

vx is self-hosted: every dev task routes through `bun src/bin.ts run <task>` per the repo's own `vx.config.ts`. No `package.json` scripts; CI invokes vx directly.

## License

MIT — see [LICENSE](./LICENSE).
