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
  lifecycle from `package.json` scripts. Materialized-artifact local
  cache; no remote yet. _Reference repo:_ `voidzero-dev/vite-task`.
- **`@vzn/vx`** — TypeScript-native config, opt-in caching, Turbo-shape
  cache key with two extensions (project package.json folded in;
  resolved-config hash captures TS imports). Bun-only. Smallest CLI
  surface; deliberately no daemon, no plugins, no JS-function tasks.
  Strict output ownership.

## Quick CLI flag map

`turbo run` / `nx run-many` / `vp run` / `vx run`:

| Capability                 | Turbo                     | Nx                         | vite-task                           | vx                                                         |
| -------------------------- | ------------------------- | -------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| pnpm-style filter DSL      | `--filter`                | `--projects`, `--exclude`  | `--filter`                          | `--filter`                                                 |
| recursive (every project)  | implicit                  | `--all`                    | `-r`                                | `--all`                                                    |
| transitive deps            | `pkg...`                  | `--with-deps` (legacy)     | `-t`                                | `pkg...` (via DSL)                                         |
| `pkg#task` addressing      | yes                       | `nx run pkg:target`        | yes                                 | yes                                                        |
| concurrency cap            | `--concurrency`           | `--parallel`               | `--concurrency-limit`               | `--concurrency`                                            |
| serialize / drop dep order | `--parallel`              | (always topo)              | `--parallel`                        | `--concurrency 1` to serialize; no `--parallel` (see note) |
| skip dependsOn             | `--only`                  | `--skipNxDependsOn`        | `--ignore-depends-on`               | `--excludeDependencies[=<names>]`                          |
| forward args               | `--`                      | `--args="..."`             | trailing args                       | `--`                                                       |
| skip cache reads+writes    | `--no-cache`, `--force`   | `--skipNxCache`            | `--no-cache`                        | `--no-cache`, `--force`                                    |
| dry-run (print plan)       | `--dry`, `--dry=json`     | `--graph` renders          | —                                   | `--dry`, `--dry=json`                                      |
| affected (git-relative)    | `--affected`              | full `affected` subcommand | —                                   | `--affected[=<base>]` + `[<since>]` filter form            |
| graph render               | `--graph file.{dot,html}` | `--graph`                  | —                                   | `--graph[=<path>]` (DOT)                                   |
| continue past failure      | `--continue=…`            | `--nx-bail` (default)      | —                                   | (always; independent siblings continue)                    |
| per-run JSON summary       | `--summarize`, `--json`   | `--outputStyle`            | `--last-details` replay             | `--summarize[=<path>]`                                     |
| output log mode            | `--output-logs=…`         | `--outputStyle=…`          | `--log=interleaved/labeled/grouped` | (always grouped/framed)                                    |
| profile / Chrome trace     | `--profile`               | (via Nx Cloud)             | —                                   | `--profile[=<path>]`                                       |
| daemon on/off              | `--daemon`/`--no-daemon`  | (Nx daemon, always on)     | —                                   | (no daemon)                                                |
| watch mode                 | `turbo watch`             | `nx watch`                 | —                                   | `vx watch <task>`                                          |
| version / help             | `--version` / `--help`    | `--version` / `--help`     | `--version` / `--help`              | `--version`, `--help` / `-h`                               |

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

| Schema feature                                       | Turbo                                                | Nx                                         | vite-task                          | vx                                              |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ----------------------------------------------- |
| Config language                                      | JSON (`turbo.json`)                                  | JSON (`project.json`, `nx.json`)           | Vite config (`run` key)            | TypeScript (`vx.config.ts`)                     |
| Per-package config                                   | yes                                                  | yes                                        | yes                                | yes                                             |
| Workspace-level config                               | `turbo.json` at root + `extends`                     | `nx.json`                                  | root `vite.config.*`               | `vx.workspace.ts` (concurrency + cacheDir only) |
| Per-task `dependsOn`: same project                   | bare name `lint`                                     | bare name                                  | bare name                          | `'lint'`                                        |
| Per-task `dependsOn`: workspace deps                 | `^lint`                                              | `^lint` or `{projects:"dependencies"}`     | `pkg#task`                         | `'^lint'`                                       |
| Per-task `dependsOn`: arbitrary other package's task | `pkg#task`                                           | `{projects:["pkg"],target:"task"}`         | `pkg#task`                         | `'pkg#task'`                                    |
| Wildcards in `dependsOn`                             | —                                                    | v19.5+: `build-*`, `^build-*`              | —                                  | — **gap**                                       |
| Group / umbrella tasks                               | tasks with `dependsOn` only                          | (achieved via target groups)               | (none)                             | yes — tasks with no `exec`                      |
| Input declarations                                   | `inputs: [...]` + `$TURBO_DEFAULT$` etc.             | `inputs: [...]` w/ rich types              | `input: glob` or `{auto:true}`     | `cache.inputs.files: string[]`                  |
| Auto-input inference                                 | —                                                    | —                                          | **yes** (`fspy` LD_PRELOAD)        | — **gap**                                       |
| Named / reusable input sets                          | (none)                                               | `namedInputs` at workspace + project level | (none)                             | — **gap**                                       |
| Per-task env inputs                                  | `env: ["NODE_ENV"]`                                  | `inputs: [{env: "NODE_ENV"}]`              | `env: [...]` + `untrackedEnv`      | `cache.inputs.env: string[]`                    |
| Pass-through env                                     | `passThroughEnv`                                     | (always pass through)                      | `untrackedEnv` (passed, no hash)   | `exec.env.passThrough`                          |
| Define / literal env                                 | (no; rely on globalEnv)                              | (via executor options)                     | (no; in script)                    | `exec.env.define`                               |
| Workspace-level env inputs                           | `globalEnv`, `globalPassThroughEnv`                  | workspace `namedInputs` + `inputs`         | (no)                               | — **gap**                                       |
| Output declarations                                  | `outputs: [...]`                                     | `outputs: [...]`                           | `output: glob` or `{pattern,base}` | `cache.outputs.files: string[]`                 |
| Output cleaning before exec / restore                | (no — additive)                                      | (no — additive)                            | (via materialized artifacts)       | **yes** — strict                                |
| Implicit-dependency hash (project `package.json`)    | (via lockfile)                                       | `externalDependencies`                     | (via lockfile)                     | **yes** — folded directly (v12)                 |
| Resolved-config hash (captures TS imports)           | —                                                    | —                                          | —                                  | **yes** — `node.config` JSON hashed             |
| Persistent / long-running tasks (dev servers)        | `persistent`, `interruptible`, `interactive`, `with` | `continuous`                               | (handled outside graph)            | `exec.persistent.readyWhen`                     |
| Configurations (named option sets)                   | —                                                    | `configurations` + `-c`                    | —                                  | — **gap**                                       |
| Per-target metadata (`description`)                  | `description`                                        | `metadata.description`                     | —                                  | `description: string`                           |
| Target defaults / inheritance                        | `extends`, task `extends`                            | `targetDefaults` (priority-resolved)       | (no)                               | — **gap**                                       |
| Pre/post script lifecycle                            | (no)                                                 | (executor-defined)                         | `enablePrePostScripts: true`       | — **gap**                                       |
| Boundaries / package-tag visibility                  | `boundaries.tags`                                    | `@nx/enforce-module-boundaries`            | (no)                               | — **gap**                                       |

## Cache feature comparison

| Cache feature             | Turbo                                      | Nx                     | vite-task                    | vx                                                                                       |
| ------------------------- | ------------------------------------------ | ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Local cache               | tarball-per-hash in `.turbo/cache`         | `.nx/cache` SQLite-ish | materialized-artifact crates | SQLite + on-disk in `.vx/cache` (one dir per entry, v13)                                 |
| Remote cache wire         | Vercel `/v8/artifacts/` (HMAC, pre-signed) | Nx Cloud or plugin     | —                            | Turbo `/v8/artifacts/` (HTTP, bearer; HMAC + pre-signed: open)                           |
| Log replay on hit         | yes                                        | yes                    | yes                          | yes                                                                                      |
| Output restore on hit     | yes                                        | yes                    | yes                          | yes                                                                                      |
| Output cleaning           | (no — additive)                            | (no)                   | (materialized)               | **yes** — wipe before exec AND before restore                                            |
| Cache pruning (CLI)       | `cacheMaxAge`, `cacheMaxSize` in config    | `maxCacheSize`         | `vp run cache clean`         | `vx cache prune --older-than / --max-size`                                               |
| Stats / run history       | `--summarize` JSON files                   | Nx Cloud dashboard     | `--last-details`             | `runs` table in `cache.db` (ULID + hrtime spans + cpu_ms + peak_rss); direct SQL queries |
| Per-run JSON summary      | `--summarize`                              | `--outputStyle`        | `--last-details`             | `--summarize[=<path>]`                                                                   |
| Chrome-trace profile      | `--profile`                                | (Nx Cloud)             | —                            | `--profile[=<path>]`                                                                     |
| HMAC signing of artifacts | yes                                        | (transport-level)      | —                            | — **gap** (open workstream)                                                              |
| Pre-signed URL auth       | yes                                        | yes                    | —                            | — **gap** (open workstream)                                                              |

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

1. **Named / reusable input sets.** Repeating `['src/**', 'tsconfig.json',
'package.json']` across every cached task is noise. Workspace-level
   schema addition.
   - Nx: `namedInputs`
     (`astro-docs/src/content/docs/reference/inputs.mdoc`).

2. **Target defaults / inheritance.** Same motivation as #1 but for
   `cache.outputs`, `dependsOn`, etc.
   - Turbo: `extends` + task `extends`.
   - Nx: `targetDefaults` (priority-resolved).

3. **Auto-input inference via filesystem tracing.** The single
   highest-leverage UX improvement over the current "you must list
   every input" rule. Big engineering lift — needs an `fspy`-
   equivalent per OS (LD_PRELOAD on Linux, Detours on Windows,
   seccomp_unotify or DTrace on macOS).
   - vite-task: `{auto: true}` is the default; backed by `crates/fspy*`.

4. **Output log modes.** A `--output-logs=full|hash-only|errors-only|none`
   flag. Common in CI.
   - Turbo: `--output-logs`, schema `outputLogs`.
   - vite-task: `--log interleaved|labeled|grouped`.

5. **Wildcards in `dependsOn`.** `build-*`, `^build-*`.
   - Nx 19.5+.

6. **HMAC artifact signing + pre-signed URLs** on the remote cache.
   Open workstream; design at
   [`design/remote-cache.md`](./design/remote-cache.md).
   - Turbo `remoteCache.signature: true`, plus pre-signed upload URLs.

7. **`--continue=<mode>`.** Today vx aborts a failed task's transitive
   dependents but continues independent siblings — Turbo's middle
   setting maps to vx's behavior already; the gap is the explicit flag
   plus the more lenient `--continue=always`.

8. **`--cache-dir <path>` CLI flag.** The workspace-config field works
   (`vx.workspace.ts`); the CLI flag doesn't. Easy add.

### Maybe-worth-adding (heavier lift, narrower payoff)

9. ~~**`vx watch` subcommand**~~ — **shipped.** `vx watch <task>` runs
   the task once, then re-runs on every filesystem change in scope.
   Same flag surface as `vx run` minus `--dry` / `--graph` /
   `--summarize` / `--profile` (which don't make sense for a loop).
   Cycles are debounced ~150ms; failed cycles don't break the loop.
   See [`cli.md` § vx watch](./cli.md#vx-watch).

10. **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`.**
    Today every task lists `tsconfig.base.json` etc. independently if
    needed; workspace-level would be a workspace fingerprint extension.
    - Turbo `globalEnv`, `globalPassThroughEnv`.

11. **Configurations (named option sets per target).** `build:prod` vs
    `build:dev` as one task with two configurations rather than two
    tasks.
    - Nx: `configurations` + `-c`.

12. **Pre/post script lifecycle.** Auto-run `prebuild`/`postbuild` from
    `package.json` scripts.
    - vite-task: `enablePrePostScripts` (default true).

13. **`vx prune` (workspace subset for Docker builds).** Useful but
    contained.
    - Turbo: `turbo prune`
      (`apps/docs/content/docs/reference/prune.mdx`).

14. **Cache TTL / size caps in config.** vx has them as CLI flags on
    `vx cache prune` but doesn't auto-evict during runs.
    - Turbo: `cacheMaxAge`, `cacheMaxSize`.
    - Nx: `maxCacheSize`.

15. **`vx stats` subcommand.** The `runs` table has the data. Today
    consumers query `cache.db` directly.

16. **Last-run replay** (`vp run --last-details`). Print the last
    run's summary without re-executing.

17. **OTel run telemetry.** Push every run's spans to an OTLP
    endpoint.
    - Turbo: `experimentalObservability.otel.*`.

### Explicitly out of scope (today)

These don't appear on the roadmap and won't be added without a
deliberate design pass.

- **Daemon / persistent project-graph process.** Re-discovery is fast
  enough on Bun; the operational cost of a daemon doesn't pay for
  itself.
- **Executor / plugin protocol.** "Shell is the API" is a deliberate
  constraint. No JS-function tasks; no executor packages.
- **Generators / scaffolding.** Not a task-runner concern.
- **TUI / interactive panes.** Streamed framed blocks are the final
  output format; no Nx-style Terminal UI.
- **Boundaries / package-tag visibility.** Module-level constraint
  rules belong in lint (`oxlint`, `eslint-plugin-import`), not the
  task runner.
- **Non-JS executor plugins.** Rust / .NET / Gradle projects use their
  own runners. vx is a JS-monorepo runner.
- **Sandboxing.** A bwrap-based attempt was reverted (Ubuntu 24
  AppArmor default blocks unprivileged user namespaces, breaking it in
  CI). Under-declared inputs producing stale hits is the accepted
  task-runner tradeoff; Turbo and Nx do the same.
- **Windows.** vx spawns POSIX shell. Cross-target binaries are built
  for linux/darwin × x64/arm64; Windows is not on the matrix.

## Where vx is ahead

Things `@vzn/vx` does that the others don't:

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
- **Bun-native everything.** `Bun.spawn` for child rusage capture,
  `bun:sqlite`, `Bun.YAML`, `Bun.Glob`, `Bun.CryptoHasher`, native
  `await import()` with a content-hash query string for config
  cache-busting. No native-binary build step on install.
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

- **No `.gitattributes` CRLF normalization.** Turbo replicates git's
  blob-hashing pipeline (CRLF conversion + `text=auto` + `autocrlf`)
  so the manual-hash fallback matches `git hash-object` byte-for-byte.
  vx hashes raw file bytes with xxh3. Tradeoff: a CRLF-converted file
  on Windows produces a different vx cache key than the same logical
  content on Linux. Document this if/when we ship Windows support.
- **No `.gitattributes` binary detection.** Same root: vx hashes raw
  bytes; we don't need to distinguish text from binary at hash time.
- **xxHash3 vs git's SHA1 blob hash.** Turbo uses git-object SHA1
  when files are tracked, falls back to manual hashing otherwise. vx
  always uses xxh3 of raw bytes. Wins ~5× speed; loses interop with
  `git hash-object` for tooling that wants to share the digest.

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

- **stdout / stderr stored in SQLite, not in the tar artifact.**
  Turbo embeds the run's logs as files inside the cache archive.
  vx separates them: the tar holds outputs only; logs live in the
  SQLite `runs` table. Decouples log retention from cache eviction;
  `vx stats` can query log history without unpacking artifacts.
- **No per-cache-entry SCM metadata.** Turbo writes the git sha +
  dirty-hash into each cache entry's metadata. vx writes run-level
  analytics only. Reconsider if we want post-hoc "what git state
  produced this artifact" queries.

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
