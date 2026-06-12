# vx

**The fastest way to build a monorepo.**

vx runs your task graph, remembers every result, and never does the
same work twice. Fully cached runs finish in milliseconds — 144 ms
across 100 packages, 0.62 s across a 1090-package graph of 3,270
tasks. Measured, reproducible, on hardware you own.

One binary. No daemon. No Node. Nothing to babysit.

```sh
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

## A cache that actually understands your build

Every task runner caches. vx caches _correctly_ — and stops work
others would redo:

- **Early cutoff.** Downstream keys are derived from the upstream's
  _output bytes_, not its inputs. Edit a comment in a library,
  rebuild it to identical `dist/` — and nothing downstream runs.
  No other runner does this.
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

- **Signed artifacts.** HMAC signing on the remote-cache wire; with a
  key configured, unsigned or tampered artifacts are rejected and the
  task simply re-runs. A poisoned cache can't reach your machines.
- **Corruption can't go live.** Artifacts are validated before they
  enter the store; bad bytes degrade to a cache miss, never a crash.
- **Clean exits.** SIGINT/SIGTERM reap every child process — no
  orphaned dev servers in CI.
- **Readiness you can bound.** Persistent tasks gate downstream work
  on a `readyWhen` signal with a `readyTimeoutMs` ceiling.
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
remote caching via two env vars, wire-compatible with existing
artifact servers · `vx stats`, `--summarize`, `--profile` Chrome
traces · `vx cache prune` with TTL and size caps.

## How it compares

|                           | vx                                           | Turborepo                      | Nx               |
| ------------------------- | -------------------------------------------- | ------------------------------ | ---------------- |
| Fully cached, 100 pkgs¹   | **144 ms**                                   | 279 ms                         | 583+ ms          |
| Early cutoff              | **Yes** — identical outputs stop the cascade | No                             | No               |
| Config                    | TypeScript, evaluated into the cache key     | JSON (static)                  | JSON (static)    |
| Output ownership          | **Strict** — wiped before exec AND restore   | Additive (stale files survive) | Additive         |
| Clean-tree hashing        | **Zero reads** (git index OIDs)              | git OIDs                       | re-hash / daemon |
| Daemon required for speed | **No**                                       | Optional                       | Yes              |
| Artifact signing          | **Hard-fail** on unsigned                    | Soft                           | No               |
| Per-task sandbox          | **Yes** — kernel-level, opt-in               | No                             | No               |
| Install                   | **Single binary** — 1 curl line              | npm + Node                     | npm + Node       |

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
      exec: { command: 'tsc -b' }, // ← name the command (Turbo reads package.json scripts)
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

`bin.ts → cli.ts` dispatches subcommands. `orchestrator.ts:run()` calls `prepareRun()` which discovers the workspace, loads configs, builds the package + task graph, and opens the cache (local SQLite + optional remote layer). The scheduler runs the graph in topological order with bounded concurrency; each task hits the cache (hash → get → restore on hit; spawn → save on miss) or short-circuits as a group / persistent. Outcomes go to the run-history table for direct SQL analytics. Every module has a docs page; every interface is a swappable seam.

Read [`docs/architecture.md`](./docs/architecture.md) for the module map and design principles.

## Documentation

Full technical docs live under [`docs/`](./docs/):

- [`docs/architecture.md`](./docs/architecture.md) — module map + data flow
- [`docs/schema.md`](./docs/schema.md) — every config field
- [`docs/caching.md`](./docs/caching.md) — cache-key derivation + invalidation table
- [`docs/execution.md`](./docs/execution.md) — `vx run` lifecycle
- [`docs/cli.md`](./docs/cli.md) — every flag
- [`docs/comparison.md`](./docs/comparison.md) — Turbo / Nx / vite-task feature matrix
- [`docs/modules/`](./docs/modules/) — one reference page per source module

## Status

**Pre-alpha.** The schema is settling; we bump `CACHE_VERSION` rather than maintain back-compat. 500+ tests; CI green on every commit; the project dogfoods itself (`bun run ci` → `vx run ci`).

Production readiness: not yet. The semantics are solid; the rough edges are operational (Windows unsupported, no published versions on npm, no managed remote-cache offering).

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
