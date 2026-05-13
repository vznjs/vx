# Compared to Turborepo, Nx, vite-task

A side-by-side reference for what each of the four tools does, plus an
explicit list of gaps `@vzn/vx` has against the other three.

This is a living document; every claim cites a source file in the
upstream repo so future revisions can be diffed against reality.

## Positioning in one paragraph each

- **Turborepo** — production-grade. Per-package `turbo.json`, daemon,
  remote cache, observability, watch, prune, query, boundaries.
  Maximally featureful; many features are flagged "experimental"; the
  flag surface is the largest of the four.
- **Nx** — production-grade and pluggable. Per-package `project.json`,
  executor plugins (Rust, .NET, Java, Gradle support), `affected`
  semantics, Terminal UI, named inputs / target defaults, distributed
  task execution via Nx Cloud agents. Heaviest schema.
- **vite-task** — Rust-fast, smallest schema, novel **filesystem-spy
  auto-input inference** (default `{auto: true}`). Pre/post script
  lifecycle from `package.json` scripts. Materialized-artifact local
  cache; no remote yet.
- **`@vzn/vx`** — TypeScript-native config, opt-in caching, Turbo-shape
  cache key with a couple of extensions (project package.json folded
  in; resolved-config hash captures imports). Bun-only. Smallest CLI
  surface; deliberately no daemon, no plugins, no watch, no JS-function
  tasks.

## Quick CLI flag map

`turbo run` / `nx run-many` / `vp run` / `vx run`:

| Capability                 | Turbo                     | Nx                         | vite-task                           | vx                                                         |
| -------------------------- | ------------------------- | -------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| pnpm-style filter DSL      | `--filter`                | `--projects`, `--exclude`  | `--filter`                          | `--filter` / `--filter` (same DSL)                         |
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
| watch mode                 | `turbo watch`             | `nx watch`                 | —                                   | — **gap**                                                  |
| version / help             | `--version`/`--help`      | `--version`/`--help`       | `--version`/`--help`                | `--version`, `--help` / `-h`                               |

Sources: Turbo `/apps/docs/content/docs/reference/run.mdx`; Nx
`/packages/nx/src/command-line/yargs-utils/shared-options.ts`;
vite-task `/crates/vite_task/src/cli/mod.rs`; vx `src/cli/run.ts`.

> **Why no `--parallel`?** Turbo's `--parallel` exists because users
> often over-declare `dependsOn` and want an escape hatch. In vx,
> `dependsOn` is opt-in and explicit — if you wrote
> `dependsOn: ['^build']` you meant it. The
> legitimate "I want to fan out without waiting" cases are already
> covered by (a) not declaring `dependsOn` in the first place, and
> (b) `--only`, which skips `dependsOn` expansion.

## Config schema comparison

| Schema feature                                       | Turbo                                                | Nx                                                | vite-task                          | vx                                              |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| Config language                                      | JSON (`turbo.json`)                                  | JSON (`project.json`, `nx.json`)                  | Vite config (`run` key)            | TypeScript (`vx.config.ts`)                     |
| Per-package config                                   | yes                                                  | yes                                               | yes                                | yes                                             |
| Workspace-level config                               | `turbo.json` at root + `extends`                     | `nx.json`                                         | root `vite.config.*`               | `vx.workspace.ts` (concurrency + cacheDir only) |
| Per-task `dependsOn`: same project                   | bare name `lint`                                     | bare name                                         | bare name                          | `'lint'`                                        |
| Per-task `dependsOn`: workspace deps                 | `^lint`                                              | `^lint` or `{projects:"dependencies"}`            | `pkg#task`                         | `'^lint'`                                       |
| Per-task `dependsOn`: arbitrary other package's task | `pkg#task`                                           | `{projects:["pkg"],target:"task"}`                | `pkg#task`                         | `'pkg#task'`                                    |
| Wildcards in `dependsOn`                             | —                                                    | v19.5+: `build-*`, `^build-*`                     | —                                  | — **gap**                                       |
| Group / umbrella tasks                               | tasks with `dependsOn` only                          | (achieved via target groups)                      | (none)                             | yes — tasks with no `exec`                      |
| Input declarations                                   | `inputs: [...]` + `$TURBO_DEFAULT$` etc.             | `inputs: [...]` w/ rich types                     | `input: glob` or `{auto:true}`     | `cache.inputs.files: string[]`                  |
| Auto-input inference                                 | —                                                    | —                                                 | **yes** (`fspy` LD_PRELOAD)        | — **gap**                                       |
| Named / reusable input sets                          | (none)                                               | `namedInputs` at workspace + project level        | (none)                             | — **gap**                                       |
| Per-task env inputs                                  | `env: ["NODE_ENV"]`                                  | `inputs: [{env: "NODE_ENV"}]`, `{runtime: "..."}` | `env: [...]` + `untrackedEnv`      | `cache.inputs.env: string[]`                    |
| Pass-through env                                     | `passThroughEnv`                                     | (always pass through)                             | `untrackedEnv` (passed, no hash)   | `exec.env.passThrough`                          |
| Define / literal env                                 | (no; rely on globalEnv)                              | (via executor options)                            | (no; in script)                    | `exec.env.define`                               |
| Workspace-level env inputs                           | `globalEnv`, `globalPassThroughEnv`                  | workspace `namedInputs` + `inputs`                | (no)                               | — **gap**                                       |
| Output declarations                                  | `outputs: [...]`                                     | `outputs: [...]`                                  | `output: glob` or `{pattern,base}` | `cache.outputs.files: string[]`                 |
| Output cleaning before exec / restore                | (no — additive)                                      | (no — additive)                                   | (via materialized artifacts)       | **yes** — strict (PR #50)                       |
| Implicit-dependency hash (project `package.json`)    | (via lockfile)                                       | `externalDependencies`                            | (via lockfile)                     | **yes** — folded directly (PR #42)              |
| Resolved-config hash (captures TS imports)           | —                                                    | —                                                 | —                                  | **yes** — `node.config` JSON hashed             |
| Persistent / long-running tasks (dev servers)        | `persistent`, `interruptible`, `interactive`, `with` | `continuous`                                      | (handled outside graph)            | — **gap**                                       |
| Configurations (named option sets)                   | —                                                    | `configurations` + `-c`                           | —                                  | — **gap**                                       |
| Per-target metadata (`description`)                  | `description`                                        | `metadata.description`                            | —                                  | — **gap**                                       |
| Target defaults / inheritance                        | `extends`, task `extends`                            | `targetDefaults` (priority-resolved)              | (no)                               | — **gap**                                       |
| Pre/post script lifecycle                            | (no)                                                 | (executor-defined)                                | `enablePrePostScripts: true`       | — **gap**                                       |
| Boundaries / package-tag visibility                  | `boundaries.tags`                                    | `@nx/enforce-module-boundaries`                   | (no)                               | — **gap**                                       |

## Cache feature comparison

| Cache feature             | Turbo                                      | Nx                     | vite-task                    | vx                                                                                        |
| ------------------------- | ------------------------------------------ | ---------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| Local cache               | tarball-per-hash in `.turbo/cache`         | `.nx/cache` SQLite-ish | materialized-artifact crates | SQLite + on-disk in `.vx/cache`                                                           |
| Remote cache wire         | Vercel `/v8/artifacts/` (HMAC, pre-signed) | Nx Cloud or plugin     | —                            | Turbo `/v8/artifacts/` (HTTP, bearer; HMAC + pre-signed: open)                            |
| Log replay on hit         | yes                                        | yes                    | yes                          | yes                                                                                       |
| Output restore on hit     | yes                                        | yes                    | yes                          | yes                                                                                       |
| Cache pruning (CLI)       | `cacheMaxAge`, `cacheMaxSize` in config    | `maxCacheSize`         | `vp run cache clean`         | `vx cache prune --older-than / --max-size`                                                |
| Stats / run history       | `--summarize` JSON files                   | Nx Cloud dashboard     | `--last-details`             | `vx stats` + `--json`; `runs` table in cache.db (ULID + hrtime spans + cpu_ms + peak_rss) |
| HMAC signing of artifacts | yes                                        | (transport-level)      | —                            | — **gap** (open workstream)                                                               |
| Pre-signed URL auth       | yes                                        | yes                    | —                            | — **gap** (open workstream)                                                               |

## Workspace integration

| Capability                                | Turbo                                   | Nx                                      | vite-task  | vx                                                                  |
| ----------------------------------------- | --------------------------------------- | --------------------------------------- | ---------- | ------------------------------------------------------------------- |
| pnpm / npm / yarn / bun workspaces        | yes                                     | yes                                     | yes        | yes (pnpm-workspace.yaml, package.json `workspaces`, bare pkg.json) |
| Non-JS projects (Rust, .NET, Gradle, ...) | no                                      | yes (plugins)                           | no         | no                                                                  |
| Filter DSL                                | pnpm-style + `[<since>]` (git-relative) | yes via `--projects/--exclude` (no DSL) | pnpm-style | pnpm-style                                                          |
| Affected / git-relative                   | `--filter '[since...]'`, `--affected`   | full `affected` subcommand              | —          | — **gap**                                                           |
| Daemon / persistent project-graph process | yes (`--daemon`)                        | yes (always-on)                         | —          | — **gap (out of scope)**                                            |
| Watch mode                                | `turbo watch`                           | `nx watch`                              | —          | — **gap (out of scope)**                                            |
| Prune workspace (Docker subset)           | `turbo prune`                           | —                                       | —          | — **gap**                                                           |

## Gaps for `@vzn/vx`

What the others have that vx doesn't, ranked by leverage. Cited file
paths are inside the respective upstream repos (Turbo
`vercel/turborepo`, Nx `nrwl/nx`, vite-task `voidzero-dev/vite-task`).

### Likely-worth-adding

1. ~~**`--dry-run` / `--dry=json`**~~ — **shipped.** Print task graph +
   cache hit/miss prediction without executing. `vx run <task>
--dry-run` for human text, `--dry-run --json` for tooling.

2. ~~**`--graph`**~~ — **shipped.** `vx run <task> --graph` prints
   Graphviz DOT to stdout. Pipe through `dot -Tsvg` to render. We
   don't write directly to file yet; Turbo's `--graph foo.html` form
   is a follow-up.

3. ~~**`--affected`**~~ — **shipped.** `vx run <task> --affected` (or
   `--affected=<ref>`) runs only the projects whose files changed
   since the given base. Default base is `origin/HEAD`, falling back
   to `HEAD~1`. Also exposed as a `[<since>]` form in the filter
   DSL — `vx run build --filter '[main]'` is the lower-level equivalent.

4. ~~**Cross-package `dependsOn` via `pkg#task`**~~ — **shipped** as
   part of the dependsOn micro-syntax refactor. Wildcards
   (`build-*`, `^build-*`) are still a gap; Nx is the only one with
   them.

5. **Named / reusable input sets.** Repeating `['src/**', 'tsconfig.json',
'package.json']` across every cached task is noise. Schema addition
   at the workspace level.
   - Nx: `namedInputs` (`astro-docs/src/content/docs/reference/inputs.mdoc`).

6. **Target defaults / inheritance.** Same motivation as #5 but for
   `cache.outputs`, `dependsOn`, etc.
   - Turbo: `extends` + task `extends`.
   - Nx: `targetDefaults` (priority-resolved).

7. **Auto-input inference via filesystem tracing.** The single
   highest-leverage UX improvement over the current "you must list
   every input" rule. Big engineering lift (need an `fspy`-equivalent
   per OS).
   - vite-task: `{auto: true}` is the default; backed by LD_PRELOAD on
     Linux, Detours on Windows, seccomp_unotify (`crates/fspy*`).

8. **`description` per task.** Trivial. Helps the interactive picker
   UX.
   - Turbo: `description`. Nx: `metadata.description`.

9. **Output log modes.** A `--output-logs=full|hash-only|errors-only|none`
   flag. Matches user-asked CI use cases.
   - Turbo: `--output-logs`, schema `outputLogs`.
   - vite-task: `--log interleaved|labeled|grouped`.

10. **Per-run JSON summary file.** Drop a `.vx/runs/<run_id>.json` with
    the outcomes for downstream tooling.
    - Turbo: `--summarize` (`apps/docs/content/docs/reference/run.mdx`).
    - We already have the data in `cache.db`'s `runs` table.

11. **HMAC artifact signing + pre-signed URLs** on the remote cache.
    Already an open workstream in CLAUDE.md.
    - Turbo `remoteCache.signature: true`, plus pre-signed upload URLs.
    - Design doc: [`design/remote-cache.md`](./design/remote-cache.md).

12. **`--continue=dependencies-successful`.** Today vx aborts a
    failed task's transitive dependents but continues independent
    siblings — Turbo's middle setting maps to vx's behavior already, so
    the gap is the explicit flag plus the more lenient
    `--continue=always` mode.

### Maybe-worth-adding (heavier lift, narrower payoff)

13. **Persistent / long-running tasks** (`dev` servers in the graph).
    Requires a different scheduler — tasks don't terminate.
    - Turbo: `persistent`, `interruptible`, `interactive`, `with`
      sidecars.
    - Nx: `continuous`.

14. **Configurations (named option sets per target).** `build:prod` vs
    `build:dev` as one task with two configurations rather than two
    tasks.
    - Nx: `configurations` + `-c`.

15. **Pre/post script lifecycle.** Auto-run `prebuild`/`postbuild` from
    `package.json` scripts.
    - vite-task: `enablePrePostScripts` (default true).

16. **`vx prune` (workspace subset for Docker builds).** Useful but
    contained.
    - Turbo: `turbo prune` (`apps/docs/content/docs/reference/prune.mdx`).

17. **Cache TTL / size caps inside config.** vx has them as CLI flags
    on `vx cache prune` but doesn't auto-evict during runs.
    - Turbo: `cacheMaxAge`, `cacheMaxSize`.
    - Nx: `maxCacheSize`.

18. **Last-run replay.** Print the last run's summary without
    re-executing.
    - vite-task: `--last-details`.

19. ~~**Profile / Chrome trace export.**~~ — **shipped** as
    `--profile[=<path>]` (PR #55). Writes a Chrome-trace JSON of
    every task's wallclock span; default path `profile.json`. One
    `tid` per project so concurrent tasks render on distinct lanes
    in `chrome://tracing` or `ui.perfetto.dev`. Same hrtime data
    also lives in `cache.db`'s `runs` table for direct SQLite
    queries. See [`cli.md`](./cli.md#run-artifacts---summarize---profile)
    for the JSON shape.

20. **OTel run telemetry.** Push every run's spans to an OTLP endpoint.
    - Turbo: `experimentalObservability.otel.*`.

### Explicitly out of scope (today)

These don't appear on the roadmap and won't be added without a
deliberate design pass:

- **Daemon / persistent project-graph process.** Re-discovery is fast
  enough; the operational cost of a daemon doesn't pay for itself.
- **Watch mode.** Tools like Vite / `bun --watch` / `tsc -b -w`
  already do this per-tool. `vx watch` would be a meta-loop; out of
  scope.
- **Executor / plugin protocol.** "Shell is the API" is a deliberate
  constraint. No JS-function tasks, no executor packages.
- **Generators / scaffolding.** Not a task runner concern.
- **TUI / interactive panes.** Streamed framed blocks are the final
  output format; no Nx-style Terminal UI.
- **Boundaries / package-tag visibility.** Module-level constraint
  rules belong in lint (`oxlint`, `eslint-plugin-import`), not the task
  runner.
- **Non-JS executor plugins.** Rust / .NET / Gradle projects use their
  own runners. vx is a JS-monorepo runner.

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
- **Single-file binary compile.** `bun build --compile src/bin.ts`
  produces a single self-contained executable.
