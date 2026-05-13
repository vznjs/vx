# vx

**A Turbo-shape monorepo task runner that's smaller, faster, and easier to live with.**

TypeScript-first config. Bun-native runtime. Content-addressed cache that's wire-compatible with the Turborepo remote-cache ecosystem. Single-binary install, no Node required.

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

## Why vx

|                             | vx                                              | Turborepo                      | Nx                            |
| --------------------------- | ----------------------------------------------- | ------------------------------ | ----------------------------- |
| Config                      | TypeScript per package                          | JSON (`turbo.json`)            | JSON (`project.json`)         |
| Caching                     | Opt-in, content-addressed                       | On-by-default                  | Opt-out (`cache: false`)      |
| Output ownership            | **Strict** — wiped before exec AND restore      | Additive (stale files survive) | Additive                      |
| Resolved-config hash        | **Yes** — captures TS imports + computed values | No (static JSON)               | No                            |
| Implicit `package.json` dep | **Yes** — folded into every task's key          | Via lockfile only              | `externalDependencies` opt-in |
| File enumeration            | `git ls-files`                                  | `git ls-files`                 | `git ls-files` (via hasher)   |
| Remote cache                | Turbo `/v8/artifacts/` wire                     | Vercel-native                  | Nx Cloud / plugin             |
| Daemon                      | **No** — every run is fresh                     | Yes (`--daemon`)               | Yes (always-on)               |
| Executor plugins            | **No** — shell is the API                       | No                             | Yes (`@nx/*` packages)        |
| Install                     | **Single binary** — 1 curl line                 | npm package + Node             | npm package + Node            |
| Watch                       | `vx watch <task>`                               | `turbo watch`                  | `nx watch`                    |
| Persistent tasks            | `exec.persistent.readyWhen` regex               | `persistent: true` flag        | `continuous: true` flag       |

vx is **the same Turbo cache mental model** with a tighter config story, a smaller surface, and stricter correctness defaults.

## What you keep when you switch from Turbo / Nx

- **The cache model.** Content-addressed hash, cascading invalidation through `dependsOn`, lockfile fingerprint, workspace-aware. Identical semantics.
- **Your remote cache.** vx speaks the Turborepo `/v8/artifacts/` wire verbatim — drop in your existing `ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`, or hosted Vercel cache server. Set two env vars and it works.
- **The filter DSL.** `--filter` accepts `app...`, `...util`, `app^...`, `!docs`, `./packages/ui`, `[main]` — the pnpm-style language Turbo and Nx both ship.
- **Affected.** `--affected[=<base>]` is sugar for `--filter '[<base>]'`. Default base is `origin/HEAD`.
- **dependsOn micro-syntax.** `'name'`, `'^name'`, `'pkg#name'`. Same shape Turbo and Nx use.
- **Cache pruning.** `vx cache prune --older-than 30d --max-size 1G`.
- **Planning.** `--dry`, `--dry=json`, `--graph` (Graphviz DOT). Skip execution; preview the cache outcome of every task.

## What's new in vx

### TypeScript config, with imports

`vx.config.ts` is regular TypeScript. Presets are functions you import. Computed values flow naturally:

```ts
import { defineProject } from '@vzn/vx'
import { tsBuild } from '@my-org/vx-presets'

export default defineProject({
  tasks: {
    build: tsBuild({ tsconfig: './tsconfig.build.json' }),
    test: {
      exec: {
        command: 'bun test',
        env: { define: { NODE_VERSION: process.versions.node } },
      },
      cache: { inputs: { files: ['src/**'], env: ['CI'] }, outputs: { files: [] } },
    },
  },
})
```

vx folds the **resolved post-evaluation config** into the cache key — so a change to your preset, or to a value pulled from `process.env` at config-load time, busts the cache automatically. Turbo and Nx hash the static config file and miss these.

### Strict output ownership

When you declare `outputs: { files: ['dist/**'] }`, vx **wipes `dist/`** before every cache restore AND before every fresh exec. Your project dir ends every run bit-identical to the cached snapshot. No stale files from a prior build can survive a cache hit.

Turbo and Nx restore additively. If yesterday's build produced `dist/old.js` and today's build doesn't, the file persists into a cache-hit replay — silently shipping stale artifacts. vx makes this impossible.

### Persistent tasks with regex readiness

```ts
dev: {
  exec: {
    command: 'vite',
    persistent: { readyWhen: 'Local:' },
  },
},
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'playwright test' },
},
```

`vx run e2e` starts the dev server, watches its output for `Local:`, then runs Playwright. The dev server is SIGTERMed at end-of-run automatically.

### Built-in profiling and run summaries

```sh
vx run ci --profile           # Chrome-trace JSON → chrome://tracing
vx run ci --summarize         # per-run JSON with hrtime spans + cpu + peak RSS
```

Every task records `cpu_ms`, `peakRssBytes`, and ns-precision hrtime spans to a SQLite `runs` table. Query it directly:

```sh
sqlite3 .vx/cache/cache.db \
  "SELECT project, task, duration_ms FROM runs ORDER BY id DESC LIMIT 5"
```

No Nx Cloud account. No Turbo dashboard. Your data, your queries.

### Single-binary install

```sh
curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
```

One binary. ~10 MB. No Node, no npm, no install dance. Auto-detects platform (`linux` / `darwin` × `x64` / `arm64`). CI startup goes from "wait for `npm install`" to "run the binary."

## Speed

vx is fast for a few compounding reasons:

- **Bun runtime.** Bun starts in tens of milliseconds; Node + npm wrappers add hundreds. The whole `vx run` invocation overhead is roughly one Bun startup.
- **`bun:sqlite` for cache metadata.** Native, no FFI, indexed lookups for "is this hash cached?" + LRU pruning.
- **`git ls-files` for inputs.** Same as Turbo and Nx — git is heavily optimized; we don't reimplement.
- **No daemon.** Every run is fresh, but workspace discovery is fast enough that the operational cost of a daemon doesn't pay for itself.
- **Bun.spawn for child processes.** Real `resourceUsage()` for CPU + peak RSS, no wrapper overhead.
- **Cache-hit replay is a file copy + log replay.** No spawn, no re-hash on hit — just SQLite SELECT + atomic dir restore.

A typical cached-everything `vx run ci` invocation in our own dogfooded workspace runs in ~50 ms total wall-clock.

## Configurability

vx is **explicit by default** — no hidden globs, no implicit fallbacks. That sounds rigid until you realize it's the same property that makes the cache trustworthy.

```ts
{
  exec: {
    command: 'bun test',
    env: {
      passThrough: ['CI', 'GH_TOKEN'],   // forwarded; not in cache key (secrets / CI flags)
      define: { NODE_ENV: 'test' },       // literal; in cache key
    },
  },
  dependsOn: ['build'],
  cache: {
    inputs: {
      files: ['src/**', 'tests/**'],
      env: ['NODE_ENV'],                  // host values that bust the cache
      tasks: ['build'],                   // upstream hashes folded in
    },
    outputs: { files: [] },               // cache the no-op success
  },
}
```

Every axis of cache identity is something you write or omit deliberately:

- **`cache.inputs.files`** — what the task reads.
- **`cache.inputs.env`** — env names whose values participate in the hash.
- **`cache.inputs.tasks`** — which upstream tasks' hashes cascade in (default: all).
- **`cache.outputs.files`** — what the task produces.
- **`exec.env.passThrough`** — host env forwarded to the child (cache-invariant).
- **`exec.env.define`** — literal env (in the cache key via the config hash).

[`docs/schema.md`](./docs/schema.md) documents every field with rationale.

## Remote cache

Environment-driven, works with any Turbo-compatible cache server:

```sh
export VX_REMOTE_CACHE_URL=https://cache.example.com
export VX_REMOTE_CACHE_TOKEN=...
# optional: VX_REMOTE_CACHE_TEAM_ID, VX_REMOTE_CACHE_SLUG, VX_REMOTE_CACHE_TIMEOUT_MS
vx run build --all
```

Reads try local first, then remote (hydrating local on remote hit). Writes go to local immediately, then upload to remote in the background — a flaky cache server never fails your build.

## CLI essentials

```
vx run [TASK | PKG#TASK ...] [--all] [--filter <pat>] [--affected[=<base>]]
                              [--concurrency <n>] [--no-cache]
                              [--excludeDependencies[=names]] [--verbosity <n>]
                              [--dry[=text|json]] [--graph[=<path>]]
                              [--summarize[=<path>]] [--profile[=<path>]]
                              [-- forwarded-args...]

vx watch TASK                 # same flags as `vx run`; re-runs on FS change
vx cache prune --older-than 30d --max-size 1G
vx help
vx --version
```

Default scope is the project containing `cwd`. `--all` broadens to every project; `--filter` accepts the pnpm DSL plus `[<git-ref>]` for affected-since-ref selection.

Output is framed per-task — no interleaving between concurrent tasks. Status indicators are Turbo-style (`cache hit • <hash>`, `executed`, `FAILED (exit N)`); the closing summary prints `>>> FULL CACHE` when every executed task hit the cache.

Full reference: [`docs/cli.md`](./docs/cli.md).

## Migrating from Turbo

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

**Pre-alpha.** The schema is settling; we bump `CACHE_VERSION` rather than maintain back-compat. 414 tests; CI green on every commit; the project dogfoods itself (`bun run ci` → `vx run ci`).

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
