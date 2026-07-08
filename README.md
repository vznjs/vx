# vx

**The fastest way to build a monorepo.**

vx runs your task graph, remembers every result, and never does the
same work twice. Fully cached runs finish in milliseconds — 144 ms
across 100 packages, 0.62 s across a 1090-package graph of 3,270
tasks. Measured, reproducible, on hardware you own.

One binary. No daemon. No Node. Nothing to babysit.

📖 **[Documentation site →](https://vznjs.github.io/vx/)** — guides,
architecture, caching, and the full CLI / config reference.

```sh
# From npm — ships the prebuilt standalone binary (no Bun required):
npm install -g @vzn/vx      # or: pnpm add -g @vzn/vx · bun add -g @vzn/vx

# Or the zero-dependency install script (no Node/npm needed):
curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
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

## Beyond a task runner — what shipped in the 2026-06 platform arc

vx now ships an **open platform**, not just a CLI. Every surface
below is built into the binary; no external services required.

```sh
vx mcp                                    # Model Context Protocol server (stdio)
                                          # — Claude Code / Cursor / Continue.dev talk to vx as a typed tool

npm i -g @vzn/vx-cloud                    # the service CLI — also a standalone binary, no Bun
vx-cloud serve --ui --open                # team backend + embedded dashboard (token-authenticated)
vx-cloud agent --url https://ci.acme.dev  # join a distributed-execution pool (Nx-Agents-style DTE)
vx-cloud connect https://ci.acme.dev      # one-URL analytics + remote cache for every `vx run`
```

### Open platform highlights

- **Provider-neutral core.** `vx` runs tasks and nothing else — the
  dashboard, remote cache, distribution, and telemetry all arrive via
  PLUGINS declared in `vx.workspace.ts`. `@vzn/vx-cloud` is the
  first-party one; anyone can write another against the same seams
  (backend / cache / telemetry).
- **MCP for AI agents, twice.** `vx mcp` (stdio, reads your real
  `cache.db`: `getCacheStats`, `getRunHistory`, `explainCacheKey`,
  `whyDidThisRerun`) and `POST /mcp` on any `vx-cloud serve` — local
  or hosted, behind the bearer token.
- **Provable cache correctness.** `vx run --verify` re-runs each
  cacheable task and byte-compares outputs; `--verify=inputs` runs it
  sandboxed against the declared inputs and names any undeclared read.
  The only runner that PROVES a cache entry safe instead of hoping.
- **Distributed CI (DTE).** `vx-cloud agent` joins a session-keyed
  pool; a `vx run` fans tasks out across same-commit agents, outputs
  propagate through the shared artifact store, and a standing pool
  multiplexes concurrent runs with fair scheduling.
- **Remote cache, one URL.** `vx-cloud connect <url>` wires analytics
  ingest AND a Turborepo-wire-compatible artifact store (HMAC signing,
  trusted/untrusted tiers derived from the token). Third-party Turbo
  cache servers work via two env vars.
- **OTel CI/CD spans.** Declare `otel()` from `@vzn/vx-otel` in
  `vx.workspace.ts` — OTLP/HTTP traces + metrics with ZERO
  OpenTelemetry SDK dependency; runs flow to Grafana / Honeycomb /
  Datadog, including `--verify` hermeticity verdicts as span status.
- **Dashboard embedded in the `vx-cloud` binary.** Runs, flamegraphs,
  live run cockpit with the task DAG, per-task logs + artifacts,
  cache-key diffs ("why did this re-run?"), flaky-task detection.
  Nothing to build or install; Docker image on ghcr for hosting.
- **Predictive scheduling.** Opt in with `predictive: true` — the
  scheduler reads run history and starts the longest expected critical
  path first.

Each surface lives behind a design doc under `docs/design/`.

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
- **Signed artifacts.** HMAC signing on the remote-cache wire; with a
  key configured, unsigned or tampered artifacts are rejected and the
  task simply re-runs. A poisoned cache can't reach your machines.
- **Cache trust tiers.** The server derives trusted/untrusted from the
  bearer token — a fork-PR artifact can never feed a trusted build.
- **Corruption can't go live.** Artifacts are validated before they
  enter the store (zstd-bomb and oversize downloads refused); bad
  bytes degrade to a cache miss, never a crash.
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
remote caching via one URL (or two env vars, wire-compatible with
existing Turbo artifact servers) · retries, timeouts, `--continue`
modes · per-layer cache control (`--cache=local:r,remote:`) ·
`vx info`, `--summarize`, `--profile` Chrome traces, `--report` ·
`vx cache prune` with TTL and size caps · `vx migrate` from
turbo.json or an Nx graph.

## How it compares

|                           | vx                                                                    | Turborepo                      | Nx                  |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------ | ------------------- |
| Fully cached, 100 pkgs¹   | **144 ms**                                                            | 279 ms                         | 583+ ms             |
| Config                    | TypeScript, evaluated into the cache key                              | JSON (static)                  | JSON (static)       |
| Output ownership          | **Strict** — wiped before exec AND restore                            | Additive (stale files survive) | Additive            |
| Clean-tree hashing        | **Zero reads** (git index OIDs)                                       | git OIDs                       | re-hash / daemon    |
| Daemon required for speed | **No**                                                                | Optional                       | Yes                 |
| Artifact signing          | **Hard-fail** on unsigned                                             | Soft                           | No                  |
| Per-task sandbox          | **Yes** — kernel-level, opt-in                                        | No                             | No                  |
| Provable cache safety     | **Yes** — `--verify` (determinism) + `--verify=inputs` (completeness) | No                             | No                  |
| MCP server for AI agents  | **Yes** (`vx mcp` stdio + `POST /mcp` on the serve)                   | No                             | No                  |
| Distributed CI execution  | **Yes** — OSS, self-hostable (`vx-cloud agent`, Nx-DTE-style)         | No                             | Paid (Nx Cloud DTE) |
| Dashboard SPA             | **Yes** — embedded in `vx-cloud serve --ui`: runs, logs, DAG, flaky   | No                             | Paid                |
| Self-hosted cloud         | **Yes** — `vx-cloud` binary or the ghcr Docker image; one stack       | Vercel-only                    | No (proprietary)    |
| Plugin API                | **Yes** — backend / cache / telemetry seams                           | No                             | Yes (TS-tied)       |
| Predictive scheduling     | **Yes** (opt-in: `predictive: true`)                                  | No                             | No                  |
| OTel CI/CD spans          | **Yes** — `otel()` plugin, zero OTel-SDK deps                         | No                             | Paid                |
| Install                   | **Single binary** — npm or 1 curl line, no Node/Bun needed            | npm + Node                     | npm + Node          |

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
- Remote cache: same wire format. Existing `VERCEL_*` / Turbo-cache-server tokens work via `VX_REMOTE_CACHE_TOKEN`.

Side-by-side feature matrix + every known gap: [`docs/comparison.md`](./docs/comparison.md).

## Architecture (one paragraph)

`bin.ts → cli/index.ts` dispatches subcommands.
`orchestrator/run.ts:run()` calls `prepareRun()` which discovers the
workspace, loads configs, builds the package + task graph, opens the
cache (local SQLite + optional remote layer), and installs plugins
from `vx.workspace.ts`. The two-tier scheduler runs the graph in
topological order with bounded concurrency (confirmed cache hits
restore ahead of their deps); each task hits the cache (hash → get →
restore on hit; spawn → save on miss) or short-circuits as a group /
persistent. Every observation flows through one event bus — the
terminal renderer subscribes directly, and PLUGINS receive the
versioned telemetry contract (`TelemetryRecord` / `RunSummaryRecord`)
— that's how `otel()` and `cloud()` export without core knowing them.
Core never imports a plugin; the arrow only points plugin → core.
Every module has a docs page; every interface is a swappable seam.

Read [`docs/architecture.md`](./docs/architecture.md) for the module
map; the design record lives under [`docs/design/`](./docs/design/).

## Documentation

Full technical docs live under [`docs/`](./docs/):

**Core**

- [`docs/architecture.md`](./docs/architecture.md) — module map + data flow
- [`docs/schema.md`](./docs/schema.md) — every config field
- [`docs/caching.md`](./docs/caching.md) — cache-key derivation + invalidation table
- [`docs/execution.md`](./docs/execution.md) — `vx run` lifecycle
- [`docs/cli.md`](./docs/cli.md) — every flag
- [`docs/comparison.md`](./docs/comparison.md) — Turbo / Nx / vite-task feature matrix
- [`docs/modules/`](./docs/modules/) — one reference page per source module

**Design + 2026-06 platform arc** (`docs/design/`)

- [`architecture-north-star-2026-06.md`](./docs/design/architecture-north-star-2026-06.md) — the unified vision
- [`architecture-review-2026-06.md`](./docs/design/architecture-review-2026-06.md) — review + applied checklist
- [`wire-protocol-2026-06.md`](./docs/design/wire-protocol-2026-06.md) — JSON-RPC 2.0 + OTel envelope (shipped)
- [`distributed-ci-2026-06.md`](./docs/design/distributed-ci-2026-06.md) — original coordinator/worker (superseded by `vx-cloud agent` DTE — `distributed-execution-2026-07.md`)
- [`vx-cloud-2026-06.md`](./docs/design/vx-cloud-2026-06.md) — original CF cloud (superseded by the standalone `vx-cloud` service)
- [`extension-protocol-2026-06.md`](./docs/design/extension-protocol-2026-06.md) — subscriber/inspector/driver/plugin (Phase 1 shipped)
- [`predictive-execution-2026-06.md`](./docs/design/predictive-execution-2026-06.md) — history-aware scheduling (Phase A-B shipped)
- [`docs/progress/implementation-log-2026-06.md`](./docs/progress/implementation-log-2026-06.md) — phase-by-phase narrative

## Status

**Pre-alpha.** The schema is settling; we bump `CACHE_VERSION` rather
than maintain back-compat. **1,400+ tests (core + packages); CI green
on every commit**; the project dogfoods itself (`vx run ci`).
Published on npm: [`@vzn/vx`](https://www.npmjs.com/package/@vzn/vx)
and `@vzn/vx-cloud`, both as prebuilt standalone binaries.

Production readiness for the **core task runner**: the semantics are
solid. The main operational rough edge is Windows (unsupported).

Production readiness for the **platform layer**:

| Surface                                        | Maturity                         | Notes                                                            |
| ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Core task runner + caching                     | **production-ready**             | dogfooded continuously; 1,150+ core tests, all green             |
| `vx run --verify` (provable cache correctness) | **shippable**                    | determinism + input-completeness proofs; CI-gate recipe in docs  |
| `vx mcp` + serve `POST /mcp`                   | **shippable**                    | live cache.db tools (stdio); serve-hosted MCP behind the bearer  |
| `vx-cloud serve` (ingest + dashboard + /v8)    | **shippable**                    | token-auth, multi-workspace, artifact store, ghcr image          |
| `vx-cloud agent` distributed execution         | **shippable for self-hosted CI** | session-keyed DTE, shared pools, fair multi-run scheduling       |
| Plugin API (backend / cache / telemetry)       | **shippable**                    | crash-isolated; `cloud()` + `otel()` are ordinary plugins        |
| Predictive scheduling                          | **shippable as opt-in**          | gated on `predictive: true` + observed data                      |
| Dashboard SPA (embedded in `vx-cloud`)         | **iterating**                    | runs/logs/DAG/flaky live; data-first entity redesign in progress |
| OTel export (`@vzn/vx-otel`)                   | **shippable**                    | declare `otel()` in `vx.workspace.ts`; OTLP traces + metrics     |

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
