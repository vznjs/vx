# Compared to Turborepo, Nx, vite-task

A side-by-side reference for what each of the four tools does, plus an
explicit list of gaps `@vzn/vx` has against the other three.

This is a living document; every claim cites a source file in the
upstream repo so future revisions can be diffed against reality.

## Positioning in one paragraph each

- **Turborepo** — production-grade. Per-package `turbo.json`, daemon,
  remote cache, observability, watch, prune, query, boundaries.
  Maximally featureful; many features are flagged "experimental"; the
  flag surface is the largest of the four. _Reference repo:_
  `vercel/turborepo`.
- **Nx** — production-grade and pluggable. Per-package `project.json`,
  executor plugins (Rust, .NET, Java, Gradle support), `affected`
  semantics, Terminal UI, named inputs / target defaults, distributed
  task execution via Nx Cloud agents. Heaviest schema. _Reference
  repo:_ `nrwl/nx`.
- **vite-task** — Rust-fast, smallest schema, novel **filesystem-spy
  auto-input inference** (default `{auto: true}`). Pre/post script
  lifecycle from `package.json` scripts. SQLite + tar.zst local cache
  with make-style validate-at-lookup (traced reads re-fingerprinted on
  every hit — gives early cutoff, but the key isn't derivable before
  execution, which is why it has no remote cache). _Reference repo:_
  `voidzero-dev/vite-task`.
- **`@vzn/vx`** — TypeScript-native config, opt-in caching, Turbo-shape
  cache key with two extensions (project package.json folded in;
  resolved-config hash captures TS imports). Bun-only. Smallest CLI
  surface; deliberately no daemon, no JS-function tasks (plugins —
  executor / backend / cache / telemetry — change WHERE a command
  runs, never what it is). Strict output ownership.

## Quick CLI flag map

`turbo run` / `nx run-many` / `vp run` / `vx run`:

| Capability                 | Turbo                     | Nx                         | vite-task                           | vx                                                                                     |
| -------------------------- | ------------------------- | -------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| pnpm-style filter DSL      | `--filter`                | `--projects`, `--exclude`  | `--filter`                          | `--filter`                                                                             |
| recursive (every project)  | implicit                  | `--all`                    | `-r`                                | `--all`                                                                                |
| transitive deps            | `pkg...`                  | `--with-deps` (legacy)     | `-t`                                | `pkg...` (via DSL)                                                                     |
| `pkg#task` addressing      | yes                       | `nx run pkg:target`        | yes                                 | yes                                                                                    |
| concurrency cap            | `--concurrency`           | `--parallel`               | `--concurrency-limit`               | `--concurrency`                                                                        |
| serialize / drop dep order | `--parallel`              | (always topo)              | `--parallel`                        | `--concurrency 1` to serialize; no `--parallel` (see note)                             |
| skip dependsOn             | `--only`                  | `--skipNxDependsOn`        | `--ignore-depends-on`               | `--excludeDependencies[=<names>]`                                                      |
| forward args               | `--`                      | `--args="..."`             | trailing args                       | `--`                                                                                   |
| skip cache reads+writes    | `--no-cache`, `--force`   | `--skipNxCache`            | `--no-cache`                        | `--no-cache` (all off) / `--force` (reads off, writes on) / `--cache=<spec>` per-layer |
| dry-run (print plan)       | `--dry`, `--dry=json`     | `--graph` renders          | —                                   | `--dry`, `--dry=json`                                                                  |
| affected (git-relative)    | `--affected`              | full `affected` subcommand | —                                   | `--affected[=<base>]` + `[<since>]` filter form                                        |
| graph render               | `--graph file.{dot,html}` | `--graph`                  | —                                   | `--graph[=<path>]` (DOT)                                                               |
| continue past failure      | `--continue=…`            | `--nx-bail` (default)      | —                                   | `--continue[=never\|deps-ok\|always]` (deps-ok default)                                |
| per-run JSON summary       | `--summarize`, `--json`   | `--outputStyle`            | `--last-details` replay             | `--summarize[=<path>]`                                                                 |
| output log mode            | `--output-logs=…`         | `--outputStyle=…`          | `--log=interleaved/labeled/grouped` | `--output-logs full\|errors-only\|none` (+ flow-derived default)                       |
| profile / Chrome trace     | `--profile`               | (via Nx Cloud)             | —                                   | `--profile[=<path>]`                                                                   |
| daemon on/off              | `--daemon`/`--no-daemon`  | (Nx daemon, always on)     | —                                   | (no daemon)                                                                            |
| watch mode                 | `turbo watch`             | `nx watch`                 | —                                   | `vx watch <task>`                                                                      |
| version / help             | `--version` / `--help`    | `--version` / `--help`     | `--version` / `--help`              | `--version`, `--help` / `-h`                                                           |

_Sources_: Turbo `/apps/docs/content/docs/reference/run.mdx`; Nx
`/packages/nx/src/command-line/yargs-utils/shared-options.ts`;
vite-task `/crates/vite_task/src/cli/mod.rs`; vx `src/cli/run.ts`.

> **Why no `--parallel`?** Turbo's `--parallel` exists because users
> often over-declare `dependsOn` and want an escape hatch. In vx,
> `dependsOn` is opt-in and explicit — if you wrote
> `dependsOn: ['^build']` you meant it. The legitimate
> "I want to fan out without waiting" cases are already covered by
> (a) not declaring `dependsOn` in the first place, and (b)
> `--excludeDependencies`, which skips dependsOn expansion entirely
> or selectively.

## Config schema comparison

| Schema feature                                       | Turbo                                                | Nx                                         | vite-task                          | vx                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| Config language                                      | JSON (`turbo.json`)                                  | JSON (`project.json`, `nx.json`)           | Vite config (`run` key)            | TypeScript (`vx.config.ts`)                                                |
| Per-package config                                   | yes                                                  | yes                                        | yes                                | yes                                                                        |
| Workspace-level config                               | `turbo.json` at root + `extends`                     | `nx.json`                                  | root `vite.config.*`               | `vx.workspace.ts` (concurrency, cacheDir, plugins, predictive)             |
| Per-task `dependsOn`: same project                   | bare name `lint`                                     | bare name                                  | bare name                          | `'lint'`                                                                   |
| Per-task `dependsOn`: workspace deps                 | `^lint`                                              | `^lint` or `{projects:"dependencies"}`     | `pkg#task`                         | `'^lint'`                                                                  |
| Per-task `dependsOn`: arbitrary other package's task | `pkg#task`                                           | `{projects:["pkg"],target:"task"}`         | `pkg#task`                         | `'pkg#task'`                                                               |
| Wildcards in `dependsOn`                             | —                                                    | v19.5+: `build-*`, `^build-*`              | —                                  | `'build.*'`, `'^build.*'` (task-name patterns; bare `*` stays filter-only) |
| Group / umbrella tasks                               | tasks with `dependsOn` only                          | (achieved via target groups)               | (none)                             | yes — tasks with no `exec`                                                 |
| Input declarations                                   | `inputs: [...]` + `$TURBO_DEFAULT$` etc.             | `inputs: [...]` w/ rich types              | `input: glob` or `{auto:true}`     | `cache.inputs.files: string[]`                                             |
| Auto-input inference                                 | —                                                    | —                                          | **yes** (`fspy`, see §3)           | — out of scope (see §3)                                                    |
| Root-anchored inputs/outputs                         | `$TURBO_ROOT$/…`                                     | `{workspaceRoot}/…`                        | (none)                             | `cache.inputs/outputs.workspaceFiles`                                      |
| Runtime-command inputs (tool versions, probes)       | — (vercel/turborepo#4124)                            | `runtime` input                            | (none)                             | `cache.inputs.runtime` / `workspaceRuntime`                                |
| Frozen / locked resolved configs                     | —                                                    | —                                          | —                                  | `vx lock` + `vx run --frozen`                                              |
| Migration generator from other runners               | —                                                    | —                                          | —                                  | `vx migrate` (turbo.json / Nx graph → vx.config.ts)                        |
| Named / reusable input sets                          | (none)                                               | `namedInputs` at workspace + project level | (none)                             | rejected by design — TS arrays/imports compose                             |
| Per-task env inputs                                  | `env: ["NODE_ENV"]`                                  | `inputs: [{env: "NODE_ENV"}]`              | `env: [...]` + `untrackedEnv`      | `cache.inputs.env: string[]`                                               |
| Pass-through env                                     | `passThroughEnv`                                     | (always pass through)                      | `untrackedEnv` (passed, no hash)   | `exec.env.passThrough`                                                     |
| Define / literal env                                 | (no; rely on globalEnv)                              | (via executor options)                     | (no; in script)                    | `exec.env.define`                                                          |
| Workspace-level env inputs                           | `globalEnv`, `globalPassThroughEnv`                  | workspace `namedInputs` + `inputs`         | (no)                               | — **gap**                                                                  |
| Output declarations                                  | `outputs: [...]`                                     | `outputs: [...]`                           | `output: glob` or `{pattern,base}` | `cache.outputs.files: string[]`                                            |
| Output cleaning before exec / restore                | (no — additive)                                      | (no — additive)                            | (via materialized artifacts)       | **yes** — strict                                                           |
| Implicit-dependency hash (project `package.json`)    | (via lockfile)                                       | `externalDependencies`                     | (via lockfile)                     | **yes** — folded directly (v12)                                            |
| Resolved-config hash (captures TS imports)           | —                                                    | —                                          | —                                  | **yes** — `node.config` JSON hashed                                        |
| Persistent / long-running tasks (dev servers)        | `persistent`, `interruptible`, `interactive`, `with` | `continuous`                               | (handled outside graph)            | `exec.persistent.readyWhen`                                                |
| Configurations (named option sets)                   | —                                                    | `configurations` + `-c`                    | —                                  | — **gap**                                                                  |
| Per-target metadata (`description`)                  | `description`                                        | `metadata.description`                     | —                                  | `description: string`                                                      |
| Target defaults / inheritance                        | `extends`, task `extends`                            | `targetDefaults` (priority-resolved)       | (no)                               | rejected by design — presets are TS imports                                |
| Pre/post script lifecycle                            | (no)                                                 | (executor-defined)                         | `enablePrePostScripts: true`       | — **gap**                                                                  |
| Boundaries / package-tag visibility                  | `boundaries.tags`                                    | `@nx/enforce-module-boundaries`            | (no)                               | — **gap**                                                                  |

## Cache feature comparison

| Cache feature            | Turbo                                      | Nx                     | vite-task                    | vx                                                                                           |
| ------------------------ | ------------------------------------------ | ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Local cache              | tarball-per-hash in `.turbo/cache`         | `.nx/cache` SQLite-ish | materialized-artifact crates | SQLite index + one `<hash>.tar.zst` per entry in `.vx/cache`                                 |
| Remote cache wire        | Vercel `/v8/artifacts/` (HMAC, pre-signed) | Nx Cloud or plugin     | —                            | plugin-driven (`@vzn/vx-reapi` ships Bazel AC/CAS; Turbo = third-party plugin story)         |
| Log replay on hit        | yes                                        | yes                    | yes                          | yes                                                                                          |
| Output restore on hit    | yes                                        | yes                    | yes                          | yes                                                                                          |
| Output cleaning          | (no — additive)                            | (no)                   | (materialized)               | **yes** — wipe before exec AND before restore                                                |
| Cache pruning (CLI)      | `cacheMaxAge`, `cacheMaxSize` in config    | `maxCacheSize`         | `vp run cache clean`         | `vx cache prune --older-than / --max-size`                                                   |
| Stats / run history      | `--summarize` JSON files                   | Nx Cloud dashboard     | `--last-details`             | `runs` + `invocations` tables in `cache.db` (direct SQL); `vx info`; a self-hosted dashboard |
| Per-run JSON summary     | `--summarize`                              | `--outputStyle`        | `--last-details`             | `--summarize[=<path>]`                                                                       |
| Chrome-trace profile     | `--profile`                                | (Nx Cloud)             | —                            | `--profile[=<path>]`                                                                         |
| Async remote prefetch    | —                                          | —                      | —                            | **yes** — stable-key GETs overlap execution                                                  |
| Restore-ahead scheduling | —                                          | —                      | —                            | **yes** — two-tier scheduler restores warm hits ahead of their deps                          |
| Artifact integrity       | HMAC `x-artifact-tag`                      | (transport-level)      | —                            | **yes** — structural `x-vx-digest` (xxh3, always on; client-verified on GET)                 |
| Pre-signed URL auth      | yes                                        | yes                    | —                            | **yes** — the platform 307s to pre-signed S3/R2 URLs; client follow drops auth               |

## Workspace integration

| Capability                                | Turbo                                   | Nx                                      | vite-task  | vx                                                                  |
| ----------------------------------------- | --------------------------------------- | --------------------------------------- | ---------- | ------------------------------------------------------------------- |
| pnpm / npm / yarn / bun workspaces        | yes                                     | yes                                     | yes        | yes (pnpm-workspace.yaml, package.json `workspaces`, bare pkg.json) |
| Non-JS projects (Rust, .NET, Gradle, ...) | no                                      | yes (plugins)                           | no         | no                                                                  |
| Filter DSL                                | pnpm-style + `[<since>]` (git-relative) | yes via `--projects/--exclude` (no DSL) | pnpm-style | pnpm-style + `[<since>]`                                            |
| Affected / git-relative                   | `--filter '[since...]'`, `--affected`   | full `affected` subcommand              | —          | `--affected[=<base>]` + `[<since>]`                                 |
| Daemon / persistent project-graph process | yes (`--daemon`)                        | yes (always-on)                         | —          | — **out of scope**                                                  |
| Watch mode                                | `turbo watch`                           | `nx watch`                              | —          | `vx watch <task>`                                                   |
| Prune workspace (Docker subset)           | `turbo prune`                           | —                                       | —          | — **gap**                                                           |

## Gaps for `@vzn/vx`

Ranked by leverage. Cited file paths are inside the respective
upstream repos.

### Likely-worth-adding

1. **Remote cache is PLUGIN-DRIVEN (owner directive 2026-07-10).** Core
   carries zero HTTP cache code: it keeps the seams (`LayeredCache`, the
   `RemoteCacheLayer` interface, the `cache` plugin capability,
   `RunOptions.remoteCache`), and a plugin ships the wire —
   `@vzn/vx-reapi` speaks Bazel's ActionCache + CAS, so NativeLink,
   BuildBuddy, Buildbarn and bazel-remote all work.
   Turbo `/v8/artifacts` compatibility was DROPPED from core; a
   Turbo-wire cache is a **third-party plugin story** — the seam recipe
   lives in the extensibility guide. (The self-hosted platform's S3 blob
   backend went with the 2026-08-23 cloud removal; its design doc lives
   in `design/archive/`.)

2. **`--continue=<mode>` — shipped.** `--continue[=never|deps-ok|always]`
   controls failure propagation: `never` fail-fast (stop dispatch on the
   first failure), `deps-ok` (default) skip only a failure's dependents
   while independent siblings continue, `always` run everything. Bare
   `--continue` = `always`. Enforced in the scheduler, threaded over the
   wire; see [`cli.md`](./cli.md) § Failure propagation.

3. **Wildcards in `dependsOn` — shipped.** `'build.*'` expands to every
   other same-project task matching the pattern (zero matches legal);
   `'^build.*'` walks the nearest-holder frontier where a holder is a
   dep declaring ≥1 match and receives edges to ALL of them. `*` is the
   sole metacharacter; bare `'*'`/`'^*'` stay filter-only
   (`cache.inputs.tasks`), and `'pkg#pattern'` is rejected. See
   [`schema.md`](./schema.md) § dependsOn.
   - Nx 19.5+ `build-*` parity.

4. **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`
   — owner-REJECTED (2026-07-05, "no global").** TypeScript configs
   compose: a shared preset imported and spread into each config IS the
   global-inputs/global-env mechanism (same rationale as the rejected
   named-inputs machinery — a schema field would duplicate the language).
   The `vx migrate` Turbo path already emits a generated `vx-preset.ts`
   for exactly this. Not a gap; will not be added.
   - Turbo `globalEnv`, `globalPassThroughEnv`.

5. **`--cache-dir <path>` CLI flag — shipped.** Overrides the
   `defineWorkspace({ cacheDir })` field + the `.vx/cache` default,
   resolved relative to cwd. Threaded over the wire; never folded into a
   cache key.

6. **Auto-input inference via filesystem tracing — owner-REJECTED
   (reconfirmed 2026-07-05, "no auto input").** Re-classified
   **out of scope** for vx (2026-06) after studying vite-task's
   implementation. Doing this soundly is a multi-platform native
   systems project — vite-task ships ~9 Rust crates for it:
   LD_PRELOAD / DYLD_INSERT_LIBRARIES interposition for glibc/macOS,
   a `seccomp_unotify` kernel supervisor for static binaries
   (esbuild, Go tools) that bypass libc, Microsoft Detours on
   Windows, a 4 GiB shared-memory IPC channel, and — because macOS
   SIP strips DYLD injection from Apple-signed binaries — their own
   shipped shell + coreutils to run commands under. Traced reads are
   re-validated at every cache lookup (not key-folded). vx cannot
   ship per-OS native helper binaries without abandoning its
   no-build-step distribution; explicit inputs stay the contract.
   - vite-task: `{auto: true}` is the default; backed by `crates/fspy*`.

### Maybe-worth-adding (heavier lift, narrower payoff)

7. **`--output-logs hash-only` — shipped (2026-08-25).** One line per
   task — outcome word, task id, cache key — with no log output; the
   run's audit trail of which key each task resolved to. All four
   Turbo modes now covered.
   - Turbo: `--output-logs`, schema `outputLogs`.

8. **Configurations (named option sets per target).** `build:prod` vs
   `build:dev` as one task with two configurations rather than two
   tasks.
   - Nx: `configurations` + `-c`.

9. **Pre/post script lifecycle.** Auto-run `prebuild`/`postbuild` from
   `package.json` scripts.
   - vite-task: `enablePrePostScripts` (default true).

10. **`vx prune` (workspace subset for Docker builds).** Useful but
    contained.
    - Turbo: `turbo prune`
      (`apps/docs/content/docs/reference/prune.mdx`).

11. **Cache TTL / size caps in config.** vx has them as CLI flags on
    `vx cache prune` but doesn't auto-evict during runs.
    - Turbo: `cacheMaxAge`, `cacheMaxSize`.
    - Nx: `maxCacheSize`.

12. **Last-run replay — shipped (2026-08-25) as `vx last`.** Replays
    the most recent (or any recorded) run's summary from the local
    history: header + per-task table, `--list` for recent run ids,
    `--format json` for scripting. Read-only over `metrics.ts`.

### Shipped since this list was first drawn

- `vx watch <task>` — debounced re-run loop.
- `--output-logs full|errors-only|none`.
- `vx info` (absorbed `vx stats`; the alias remains).
- Artifact integrity on the native cache wire (`x-vx-digest`, replacing
  the retired Turbo-compatible HMAC signing).
- OTel run telemetry — the `otel()` plugin in `@vzn/vx-otel` (declare
  it in `vx.workspace.ts` + set `OTEL_EXPORTER_OTLP_ENDPOINT`).
- Per-task OS sandboxing (`sandbox: {…}`, SRT-backed,
  fail-on-violation).
- Root-anchored inputs/outputs (`workspaceFiles`) and runtime-command
  inputs (`runtime` / `workspaceRuntime`).
- `vx lock` / `vx run --frozen`, `vx migrate`, `vx show`, `vx mcp`.

### Explicitly rejected (owner decisions — do not re-propose)

- **Named / reusable input sets (`namedInputs`) and target defaults /
  inheritance.** TypeScript configs compose — shared presets via
  import ARE vx's named inputs and defaults; schema machinery would
  duplicate the language.
- **Transparent config-eval caching.** Purity heuristics are
  correctness-critical machinery for a modest win; `vx lock` is the
  explicit-user-action answer.

### Explicitly out of scope (today)

These don't appear on the roadmap and won't be added without a
deliberate design pass.

- **Daemon / persistent project-graph process.** Re-discovery is fast
  enough on Bun (and config loading is scoped); the operational cost
  of a daemon doesn't pay for itself.
- **Executor plugin protocol.** "Shell is the API" is a deliberate
  constraint. No JS-function tasks; no executor packages. (The
  shipped `VxPlugin` system is run-level infrastructure — backend /
  cache / telemetry — and cannot change task execution.)
- **Generators / scaffolding.** Not a task-runner concern.
- **TUI / interactive panes.** Streamed framed blocks + the worker
  status region are the terminal format; no Nx-style Terminal UI (an
  attempt was built and dropped). The browsable surface is the
  self-hosted dashboard.
- **Boundaries / package-tag visibility.** Module-level constraint
  rules belong in lint (`oxlint`, `eslint-plugin-import`), not the
  task runner.
- **Non-JS executor plugins.** Rust / .NET / Gradle projects use their
  own runners. vx is a JS-monorepo runner.
- **Windows.** vx spawns POSIX shell. Cross-target binaries are built
  for linux/darwin × x64/arm64; Windows is not on the matrix.

## Where vx is ahead

Things `@vzn/vx` does that the others don't:

- **Provable cache correctness (`vx run --verify`).** Every content-
  addressed cache rests on two unstated assumptions — that a task run
  twice on the same inputs produces the same bytes, and that the inputs
  you declared are its whole read set. Turbo and Nx assume both and hope;
  either a non-deterministic task or an undeclared input silently poisons
  their cache. vx is the only runner that _proves_ both. `--verify`
  (`=determinism`) re-runs each executed cacheable task and
  content-compares the outputs (git-blob OID per file): divergent ⇒
  non-hermetic ⇒ run **fails** naming the changed paths. `--verify=inputs`
  runs the task once through vx's OS sandbox with the declared inputs as
  the only readable workspace paths: a read of any undeclared workspace
  file ⇒ incomplete inputs ⇒ run **fails** naming it. `--verify=all` does
  both. A pure run-level side-channel (never touches a cache key, so a
  `--verify` run still hits a plain entry), ~2× exec — a CI / pre-merge
  gate. It's the correctness-first inverse of input auto-inference: vx
  never guesses your inputs, it proves the declared ones are complete and
  reproducible enough to cache safely.
- **TypeScript config with full type inference** — no string typos,
  IDE autocomplete, presets as plain imports. The closest thing in
  Turbo/Nx is `extends`; in vite-task it's tied to Vite's config
  loader.
- **Resolved-config hash.** Imports and computed values get folded
  into the cache key because the post-evaluation object is what we
  serialize. Turbo and Nx hash the static JSON file and miss anything
  computed at config-load time.
- **Project `package.json` hash folded in automatically.** Turbo and
  Nx get this transitively via the lockfile; vx folds the per-project
  bytes directly, so narrow `inputs.files` like `['src/**']` doesn't
  miss dep / version-bump invalidation.
- **Strict output ownership.** Declared `cache.outputs.files` are
  wiped before exec AND before cache restore. Both Turbo and Nx
  restore additively; stale files from a prior build survive a cache
  hit there.
- **Group tasks as first-class.** A task with no `exec` (just
  `dependsOn`) is a pure aggregator; doesn't appear in the run output,
  isn't counted in the summary, isn't recorded in analytics.
- **Runtime-command inputs.** `cache.inputs.runtime` /
  `workspaceRuntime` fold a probe command's live output into the key
  (tool versions, OS info) — Nx has `runtime`; Turbo has no
  equivalent (vercel/turborepo#4124).
- **Restore-ahead two-tier scheduling.** A stable-key warm hit
  restores immediately, before its deps finish running, as worker
  backfill — misses still own the pool. Remote runs get the same idea
  as async prefetch (remote GETs overlap execution, at most one per
  key).
- **`vx lock` / `--frozen`.** Configs are programs; the lock freezes
  the resolved objects for CI reproducibility, with a full
  re-evaluation audit (`vx lock --check`). No analog in Turbo/Nx.
- **`vx migrate`.** One command generates per-package `vx.config.ts`
  from `turbo.json` or an Nx project graph, with TODO comments for
  everything unmappable.
- **A versioned telemetry contract + plugin seam.** `TelemetryRecord`
  / `RunSummaryRecord` (TELEMETRY_SCHEMA_VERSION) is one neutral
  export shape every sink reads — OTel, a self-hosted dashboard, or a
  custom sink — observe-only by construction, zero cost when unused.
- **Bun-native everything.** `Bun.spawn` for child rusage capture,
  `bun:sqlite`, `Bun.YAML`, `Bun.Glob`, `Bun.hash.xxHash3`,
  `Bun.zstdCompress`, native `await import()` with a content-hash
  query string for config cache-busting. No native-binary build step
  on install.
- **One-binary distribution.** `bun build --compile` produces a
  single self-contained executable per platform target. The install
  script downloads one binary from a GitHub release — no Node, no
  pnpm, no install footprint.
- **Wallclock-ns analytics out of the box.** Every task records
  hrtime spans relative to the run's t=0; `cache.db`'s `runs` table
  is queryable with `sqlite3` directly; `--profile` exports
  Chrome-trace JSON without any additional setup.
- **Persistent tasks with regex-readiness.** `readyWhen: 'Local:'`
  for a dev server is a one-liner; downstream tasks unblock on ready,
  not on exit. Turbo's `persistent` is more elaborate (separate
  `interruptible` / `interactive` / `with` flavors); vx's surface is
  smaller.
- **Explicit `cache + persistent` rejection.** The project loader
  throws — no silent surprise.

## Deliberate divergences from Turbo / Nx

These are places where Turbo or Nx pin a specific behavior in their
test suites and `vx` deliberately does something else. Listed here so
the choices don't drift accidentally — if any of these change, the
rationale below needs revisiting. Sourced from the full gap analysis
in [`design/turbo-nx-test-gaps.md`](./design/turbo-nx-test-gaps.md).

### Hashing pipeline

- **Git blob OIDs for input files, like Turbo (v20).** Tracked clean
  files contribute their index OID (harvested from the same bulk
  `git ls-files -s` spawn that enumerates files — zero reads on a
  clean tree); dirty/untracked files fall back to an in-process
  blob-OID computation that is byte-identical for identical content.
  The KEY composition on top of those per-file OIDs is xxHash3
  (16-hex), not SHA — Turbo composes with xxh64; the widths match.
- **No `.gitattributes` CRLF normalization in the fallback.** Turbo's
  manual-hash fallback replicates git's CRLF conversion so it matches
  `git hash-object` under `text=auto` / `autocrlf`. vx's in-process
  fallback hashes raw bytes (`blob <len>\0` + content) — identical to
  the index OID on Linux/macOS; a CRLF-converting Windows checkout
  could diverge. Document this if/when Windows ships.
- **No `.gitattributes` binary detection.** Same root: raw bytes; no
  text-vs-binary distinction needed at hash time.

### Task graph

- **`forwardArgs` does NOT inherit into `dependsOn` deps.** Nx
  forwards args/options into dependents via `options: 'forward'`.
  vx scopes `forwardArgs` to user-requested nodes only — passing
  `vx run build -- --foo` does NOT pollute upstream tasks' cache keys.
  Explicit > magical (see CLAUDE.md decision log entry P1).
- **No tag-based selectors (`tag:foo`, `!tag:bar`).** Nx has project
  tags as a generator/devkit concept. vx project identity is
  workspace path + package.json name only.

### Filter DSL

- **Stacked `--filter name --filter [ref]` is UNION, not intersection.**
  Turbo's discussion #9096 argues for intersection ("only packages
  that are both affected AND match the name"). vx unions
  (tests/filter.test.ts > applyFilters > stacked: --filter ui
  --filter [main] unions name + affected sets). Mental model: each
  filter ADDS to the selection; never narrows another filter's set.
- **Filter mode is not classified into all-vs-exclude-vs-explicit.**
  Turbo decides whether to start from the universe or the empty set
  based on whether the filter list contains any positive selector;
  vx always starts from the universe and applies filters as set ops.
  Same observable behavior for every documented case; simpler
  implementation.

### Affected detection

- **Project removal does NOT invalidate every project's cache.** Nx
  invalidates everything when a project is removed. vx already folds
  each project's `package.json` bytes into every task's cache key
  (PR #42, CACHE_VERSION → v12), which catches "project gone" at
  finer granularity — only tasks that actually consumed the gone
  project's bytes are busted.
- **`git diff --no-renames` for affected.** vx flips rename
  detection OFF so cross-project `git mv` flags BOTH source and
  destination projects. Turbo's default rename-on would surface only
  the destination, silently missing the source's affected status.

### Cache storage

- **stderr is not cached; stdout is stored twice on purpose.** Turbo
  embeds the run's full logs inside the cache archive. vx's artifact
  is exactly `stdout` + `outputs/` (only successful runs are cached
  and their stderr is near-always empty); stdout ALSO lives in the
  SQLite `entries` row so a local hit replays it with pure SQL —
  never decompressing the artifact.
- **Per-run SCM metadata, not per-entry.** Turbo writes the git sha +
  dirty-hash into each cache entry's metadata. vx records git
  commit/branch/dirty on the per-run `invocations` row instead, and
  the per-component `entry_inputs` rows answer "what inputs produced
  this artifact" at finer granularity.

### Remote cache

- **No token refresh on 403.** Turbo refreshes the bearer token on 403. vx remote auth is static; a revoked token surfaces as an
  immediate failure rather than a silent retry loop. Revisit if
  hosted-cache use grows.

### Glob walking

- **`**` symlink-following defers to Bun.Glob.\*\* Turbo distinguishes
  shallow-wildcard vs doublestar follow-link behavior explicitly.
  vx defers to Bun.Glob's defaults — symlinks under the project
  directory are followed; the symlink-cycle test pins that the
  resolver doesn't hang. Document via pinning test rather than
  reimplementing Turbo's distinction.

### Engine / scheduling

- **No executor batching.** Nx batches same-executor tasks into a
  single child process. vx has no executor concept — shell is the
  API. Tradeoff: more spawn overhead; far simpler model.
- **No incremental watcher state.** Turbo's watcher maintains rich
  incremental change-accumulator + rediscover state. vx re-runs the
  orchestrator from scratch on each cycle. Cheap because of
  `gitFilesCache` + `Cache.hashFile` mtime+size fast path; complexity
  not yet justified.

### Config schema

- **No `$WORKSPACE_ROOT$` / `$TURBO_ROOT$` token substitution.**
  Turbo + Nx use template tokens in path strings; vx uses real paths
  from the project-dir context. The path resolution context is
  unambiguous because every glob is scoped per-project.

### Env handling

- **No `.env` auto-loading.** Nx auto-loads `.env` files. vx
  requires explicit `cache.inputs.env` declarations. "Explicit over
  magical" (architecture principle #1).
- **No wildcards in `cache.inputs.env`.** Turbo supports `VERCEL_*`
  expansion. vx rejects wildcards at load time so a typo doesn't
  silently contribute an empty value to the cache key (pinned by
  tests/project-loader.test.ts > rejects wildcards in
  cache.inputs.env).

### Concurrency model

- **Single-event-loop JS, no shared mutex.** Turbo uses
  `RwLock<TaskHashTracker>` and tests concurrent reads + read/write.
  vx is single-threaded JS by construction — no shared mutable state
  across "threads" to race over.
