# Compared to Turborepo, Nx, vite-task

A side-by-side reference for what each of the four tools does, plus an
explicit list of gaps `@vzn/vx` has against the other three.

This is a living document; every claim cites a source file or reference
page in the upstream repo so future revisions can be diffed against
reality. Last verified 2026-09-03 against `turbo@2.10.12`, `nx@23.2.0`
and `voidzero-dev/vite-task` `main` (now the engine behind Vite+'s
`vp run`).

## Positioning in one paragraph each

- **Turborepo** — production-grade. Per-package `turbo.json`, remote
  cache, OTLP observability, watch, prune, query, boundaries, a TUI.
  Maximally featureful; many features are flagged "experimental", and
  2.10 deprecates its own daemon, `--parallel`, `--no-cache` and
  `--remote-only`; the flag surface is the largest of the four.
  _Reference repo:_ `vercel/turborepo`.
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
  surface; deliberately no daemon and no JS-function tasks. The core is
  a Vite-style pipeline: plugins hook each stage (`config` → `project`
  → `graph` → `key` → `schedule`), supply the executor (WHERE a command
  runs, never what it is), the cache layers and the telemetry sinks,
  and add verbs — core applies none of them by default. Strict output
  ownership.

## Quick CLI flag map

`turbo run` / `nx run-many` / `vp run` / `vx run`:

| Capability                 | Turbo                                                        | Nx                                              | vite-task                           | vx                                                                                      |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| pnpm-style filter DSL      | `--filter`                                                   | `--projects`, `--exclude`                       | `--filter`                          | `--filter`                                                                              |
| recursive (every project)  | implicit                                                     | `--all`                                         | `-r`                                | `--all`                                                                                 |
| transitive deps            | `pkg...`                                                     | `--with-deps` (legacy)                          | `-t`                                | `pkg...` (via DSL)                                                                      |
| `pkg#task` addressing      | yes                                                          | `nx run pkg:target`                             | yes                                 | yes                                                                                     |
| concurrency cap            | `--concurrency`                                              | `--parallel`                                    | `--concurrency-limit`               | `--concurrency`                                                                         |
| serialize / drop dep order | `--parallel` (deprecated)                                    | (always topo)                                   | `--parallel`                        | `--concurrency 1` to serialize; no `--parallel` (see note)                              |
| skip dependsOn             | `--only`                                                     | `--excludeTaskDependencies`                     | `--ignore-depends-on`               | `--excludeDependencies[=<names>]`                                                       |
| forward args               | `--`                                                         | `--args="..."`                                  | trailing args                       | `--`                                                                                    |
| skip cache reads+writes    | `--cache=<spec>`, `--force` (`--no-cache` deprecated)        | `--skipNxCache`, `--skipRemoteCache`            | `--no-cache`                        | `--no-cache` (all off) / `--force` (reads off, writes on) / `--cache=<spec>` per-layer  |
| dry-run (print plan)       | `--dry`, `--dry=json`                                        | `--graph` renders                               | —                                   | `--dry`, `--dry=json`                                                                   |
| affected (git-relative)    | `--affected`                                                 | full `affected` subcommand                      | —                                   | `--affected[=<base>]` + `[<since>]` filter form                                         |
| graph render               | `--graph file.{dot,html}`                                    | `--graph`                                       | —                                   | `--graph[=<path>]` (DOT)                                                                |
| continue past failure      | `--continue=never\|dependencies-successful\|always`          | `--nxBail`                                      | —                                   | `--continue[=never\|deps-ok\|always]` (deps-ok default)                                 |
| per-run JSON summary       | `--summarize`, `--json`                                      | `--outputStyle`                                 | `--last-details` replay             | `--summarize[=<path>]`                                                                  |
| output log mode            | `--output-logs=full\|hash-only\|new-only\|errors-only\|none` | `--outputStyle=tui\|dynamic\|static\|stream\|…` | `--log=interleaved/labeled/grouped` | `--output-logs full\|hash-only\|errors-only\|none` (+ flow-derived default)             |
| profile / Chrome trace     | `--profile`                                                  | (via Nx Cloud)                                  | —                                   | `--profile[=<path>]`                                                                    |
| daemon on/off              | (deprecated in 2.10; ignored)                                | (Nx daemon, always on)                          | —                                   | (no daemon)                                                                             |
| retries / timeouts         | —                                                            | —                                               | —                                   | `--retry <n>`, `--timeout <dur>` (also per task in config)                              |
| remote placement / outputs | — (remote cache only)                                        | Nx Cloud agents                                 | —                                   | `--download=all\|toplevel\|none`, `exec.remote` (executor plugin, e.g. `@vzn/vx-reapi`) |
| run report                 | `--summarize`                                                | —                                               | —                                   | `--report=markdown`, `--report-file`; `vx last` replays any recorded run                |
| watch mode                 | `turbo watch`                                                | `nx watch`                                      | —                                   | `vx watch <task>`                                                                       |
| version / help             | `--version` / `--help`                                       | `--version` / `--help`                          | `--version` / `--help`              | `--version`, `--help` / `-h`                                                            |

_Sources_: Turbo `/docs/reference/run` (turborepo.dev, 2.10.12); Nx
`/reference/core-api/nx/documents/run-many` (nx.dev, 23.2.0);
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
| Workspace-level config                               | `turbo.json` at root + `extends`                     | `nx.json`                                  | root `vite.config.*`               | `vx.workspace.ts` (concurrency, cacheDir, timeout, plugins)                |
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

| Cache feature            | Turbo                                      | Nx                     | vite-task                    | vx                                                                                   |
| ------------------------ | ------------------------------------------ | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| Local cache              | tarball-per-hash in `.turbo/cache`         | `.nx/cache` SQLite-ish | materialized-artifact crates | SQLite index + one `<hash>.tar.zst` per entry in `.vx/cache`                         |
| Remote cache wire        | Vercel `/v8/artifacts/` (HMAC, pre-signed) | Nx Cloud or plugin     | —                            | plugin-driven (`@vzn/vx-reapi` ships Bazel AC/CAS; Turbo = third-party plugin story) |
| Log replay on hit        | yes                                        | yes                    | yes                          | yes                                                                                  |
| Output restore on hit    | yes                                        | yes                    | yes                          | yes                                                                                  |
| Output cleaning          | (no — additive)                            | (no)                   | (materialized)               | **yes** — wipe before exec AND before restore                                        |
| Cache pruning (CLI)      | `cacheMaxAge`, `cacheMaxSize` in config    | `maxCacheSize`         | `vp run cache clean`         | `vx cache prune --older-than / --max-size`                                           |
| Stats / run history      | `--summarize` JSON files                   | Nx Cloud dashboard     | `--last-details`             | `runs` + `invocations` tables in `cache.db` (direct SQL); `vx info`; `vx last`       |
| Per-run JSON summary     | `--summarize`                              | `--outputStyle`        | `--last-details`             | `--summarize[=<path>]`                                                               |
| Chrome-trace profile     | `--profile`                                | (Nx Cloud)             | —                            | `--profile[=<path>]`                                                                 |
| Async remote prefetch    | —                                          | —                      | —                            | **yes** — stable-key GETs overlap execution                                          |
| Restore-ahead scheduling | —                                          | —                      | —                            | **yes** — two-tier scheduler restores warm hits ahead of their deps                  |
| Artifact integrity       | HMAC `x-artifact-tag`                      | (transport-level)      | —                            | **yes** — every blob re-hashed on read against the digest it was requested under     |
| Pre-signed URL auth      | yes                                        | yes                    | —                            | plugin's business — core ships the `cache` seam, not a transport                     |

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

## Gap audit 2026-09-04 — what a developer would miss, core or plugin

The owner's question: which Nx 23 / Turbo 2.10 features are a MUST or
a game changer for developers, and of those, which belong in core.
Rule applied: if a plugin can do it through an existing seam, it is
not core. Every row below was checked against `docs/cli.md`,
`docs/schema.md` and the source, not remembered.

**Verified present in core** (parity or ahead): the task graph with
`^task` / wildcards / nearest-holder frontier; `--filter` as a superset
of Turbo's DSL (`...`, `^...`, `!`, `./dir`, `[git-ref]`) and
`--affected`; caching with declared inputs, outputs, `inputs.env`,
workspace files; strict env isolation (Turbo's
`--env-mode=strict` is vx's only mode); `persistent` tasks with
readiness gating (ahead of Turbo's `persistent` and Nx's
`continuous`); the interactive picker; `watch`, `prune`, `--dry`,
`--graph`, `--summarize`, `--profile`, `--continue` modes, retries,
timeouts, `--memory`, `--output-logs` modes; `migrate` from Turbo, Nx
and scripts; `init`; the cwd-scoped default; `last`, `why`, `show`,
`info`; remote cache and execution through the seams (`@vzn/vx-reapi`).

**Missing, and where it belongs:**

| Feature                                                                     | Nx / Turbo    | Verdict                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zero-config adoption: `package.json` scripts are tasks, no per-package file | both, in core | The one game changer. The mapping is a `project`-stage PLUGIN (`@vzn/vx-turbo` / `-nx` reusing the migrate mappers); core needs ONE seam widening — visit a config-less package when a plugin declares `project` (STATUS § Next 3). Recommended. |
| Inferred tasks from tool configs (`vite.config` ⇒ build/serve/test)         | Nx plugins    | Same seam, same plugin family. Not core.                                                                                                                                                                                                         |
| `.env` files loaded into the task env                                       | Nx            | Tasks read their own `.env` (Vite, Next do); the cache side is `cache.inputs.files: ['.env*']`. A `config`-stage plugin can inject. Not core; a docs footnote.                                                                                   |
| Configurations (`build:prod` as one task, two modes)                        | Nx            | The language: a TS function returning the task per mode. Not core.                                                                                                                                                                               |
| Cache size / age caps applied during runs                                   | both          | The local-cache PLUGIN owns storage; an option there. Not core.                                                                                                                                                                                  |
| Graph UI, TUI, dashboards                                                   | both          | Rejected for core; `--graph` emits the data for a plugin or a site.                                                                                                                                                                              |
| Versioning and publishing (`nx release`)                                    | Nx            | `commands` seam; changesets already exists. Not core.                                                                                                                                                                                            |
| Test splitting (Nx atomizer)                                                | Nx            | `graph`-stage plugin. Not core.                                                                                                                                                                                                                  |
| Import boundaries (`turbo boundaries`)                                      | Turbo         | A lint; out of scope.                                                                                                                                                                                                                            |
| Shell completions                                                           | both          | Nice, small (~40 lines on the verb table), not a must. Later.                                                                                                                                                                                    |
| Windows                                                                     | both          | The only must that no plugin can supply; parked by the owner (POSIX shell is the API). Not proposed.                                                                                                                                             |

Net: core is at parity or ahead on the must-haves; the gap that costs
adoption is the trial with no generated files, and its core half is a
small seam. Everything else is a plugin or the language.

## Gaps for `@vzn/vx` (the running list)

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
   lives in the extensibility guide.

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
   tasks. vx's answer today is the language: a TS function returning
   the task for a mode, spread into two tasks, plus a group over both.
   - Nx: `configurations` + `-c`.

9. **Pre/post script lifecycle — shipped in `vx init` (2026-09-03).**
   `pre<x>` / `post<x>` scripts fold into `x`'s command in npm order
   when the config is generated, so the ordering survives as a plain
   command rather than as runtime magic; a script that only delegates
   (`npm run other`) becomes a group over `other`. Not applied at run
   time: a task's command is exactly what its config says.
   - vite-task: `enablePrePostScripts` (default true).

10. **`vx prune` — shipped (2026-08-25).** Workspace subset for Docker
    builds: target + transitive workspace deps, rewritten
    `pnpm-workspace.yaml`, root manifests, unpruned lockfile
    (deliberate — per-format lockfile pruning is out of phase 1),
    `--docker` json/full split for layer caching.
    - Turbo: `turbo prune`.

11. **Cache TTL / size caps in config.** vx has them as CLI flags on
    `vx cache prune` but doesn't auto-evict during runs.
    - Turbo: `cacheMaxAge`, `cacheMaxSize` (verified in the 2.10
      configuration reference).
    - Nx: `maxCacheSize`.

12. **Last-run replay — shipped (2026-08-25) as `vx last`.** Replays
    the most recent (or any recorded) run's summary from the local
    history: header + per-task table, `--list` for recent run ids,
    `--format json` for scripting. Read-only over `metrics.ts`.

### Shipped since this list was first drawn

- `vx watch <task>` — debounced re-run loop.
- `--output-logs full|errors-only|none`.
- `vx info` (absorbed `vx stats`; the alias remains).
- Artifact integrity by content addressing — every blob re-hashed on
  read against the digest it was requested under (replacing both the
  retired Turbo-compatible HMAC signing and the retired native wire).
- OTel run telemetry — the `otel()` plugin in `@vzn/vx-otel` (declare
  it in `vx.workspace.ts` + set `OTEL_EXPORTER_OTLP_ENDPOINT`).
- Per-task OS sandboxing (`exec.sandbox`, SRT-backed,
  fail-on-violation).
- Root-anchored inputs/outputs (`workspaceFiles`) and runtime-command
  inputs (`runtime` / `workspaceRuntime`).
- `vx lock` / `vx run --frozen`, `vx migrate`, `vx show`.
- **The plugin pipeline (2026-09-02).** One `VxPlugin` hooks every
  stage — `config`, `project`, `graph`, `key`, `schedule` — beside the
  `executor` / `cache` / `telemetry` capabilities and `commands` (new
  verbs). Core applies no plugin by default; a workspace declares all
  of them.
- **A config evaluation cache** for provably pure configs
  (`src/workspace/config-cache.ts`): a lexer-backed purity GATE, not a
  heuristic — any `/` outside a comment, any non-`@vzn/vx` bare import,
  or a closure past 32 files opts a config out. Warm 1000-project run
  ~400 → 237 ms with the rest of the perf waves.
- `vx init` (scripts → configs), `vx why`, `vx last`, `vx prune`,
  `--download`, remote execution through `@vzn/vx-reapi`,
  `@vzn/vx-github` (job summary + check run), `@vzn/vx-mcp` (an MCP
  server as a plugin verb), the `schedule-history` plugin (critical-path
  priorities from recorded durations).
- npm distribution as per-platform binary packages plus a launcher,
  signed on macOS.

### Explicitly rejected (owner decisions — do not re-propose)

- **Named / reusable input sets (`namedInputs`) and target defaults /
  inheritance.** TypeScript configs compose — shared presets via
  import ARE vx's named inputs and defaults; schema machinery would
  duplicate the language.

### Explicitly out of scope (today)

These don't appear on the roadmap and won't be added without a
deliberate design pass.

- **Daemon / persistent project-graph process.** Re-discovery is fast
  enough on Bun (a warm 1000-project run is ~240 ms end to end, with
  config loading scoped and pure configs served from the eval cache);
  the operational cost of a daemon doesn't pay for itself. Turbo 2.10
  reached the same conclusion and deprecated its daemon for `run`.
- **JS-function tasks.** "Shell is the API" is a deliberate
  constraint: a task is a command string. The `executor` capability
  decides WHERE that command runs (a worker, a sandbox, this machine)
  and the pipeline hooks shape what the graph contains and how it is
  keyed and ordered — none of them can replace the command with code.
- **Generators / scaffolding.** Not a task-runner concern.
- **TUI / interactive panes.** Streamed framed blocks + the worker
  status region are the terminal format; no Nx-style Terminal UI (an
  attempt was built and dropped). `vx last` replays a recorded run from
  the local history; anything browsable is a telemetry-plugin story
  now that the self-hosted dashboard is gone (2026-08-23).
- **Boundaries / package-tag visibility.** Module-level constraint
  rules belong in lint (`oxlint`, `eslint-plugin-import`), not the
  task runner.
- **Non-JS executor plugins.** Rust / .NET / Gradle projects use their
  own runners. vx is a JS-monorepo runner.
- **Windows.** vx spawns POSIX shell. Cross-target binaries are built
  for linux/darwin × x64/arm64; Windows is not on the matrix.

## Where vx is ahead

Things `@vzn/vx` does that the others don't:

- **A Vite-style pipeline instead of a feature list.** Every stage
  has a hook and every capability is a plugin, in declaration order,
  with core re-validating what a hook returns. A plugin can fold a
  value into every cache key (`key`, and `vx why` shows it by plugin
  name), rewrite a project's tasks, add an edge, reorder the schedule,
  or add a verb — so "vx doesn't do X" is answered with a plugin, not
  a fork. Turbo has no plugin surface; Nx's is executors + generators.
- **`vx why` — cache-key explainability.** Per-component input
  fingerprints are recorded on every miss, so a re-run is explained by
  diffing two keys: which file, env var, upstream key or plugin part
  moved. Turbo's `--summarize` and Nx's cache view show hashes, not the
  diff.
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
  export shape every sink reads — OTel (`@vzn/vx-otel`), the GitHub
  job summary and check run (`@vzn/vx-github`), or a custom sink —
  observe-only by construction, zero cost when unused.
- **Bun-native everything.** `Bun.spawn` for child rusage capture,
  `bun:sqlite`, `Bun.YAML`, `Bun.Glob`, `Bun.hash.xxHash3`,
  `Bun.zstdCompress`, native `await import()` with a content-hash
  query string for config cache-busting. No native-binary build step
  on install.
- **One-binary distribution.** `bun build --compile` produces a
  single self-contained executable per platform target, published as
  per-platform npm packages behind a tiny launcher (the esbuild model)
  and as GitHub release assets — no Bun or Node needed at runtime.
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

- **No remote wire in core.** Turbo ships its HTTP cache client
  (bearer token, refresh on 403, preflight, timeout) inside the
  binary; vx core ships the `cache` seam and nothing else. The wire,
  its auth and its deadlines belong to the plugin — `@vzn/vx-reapi`
  speaks Bazel's ActionCache + CAS over gRPC with a per-call deadline
  on every cache-path RPC, and a remote error always degrades to a
  MISS rather than failing the run.

### Glob walking

- **`**` symlink-following defers to Bun.Glob.\*\* Turbo distinguishes
  shallow-wildcard vs doublestar follow-link behavior explicitly.
  vx defers to Bun.Glob's defaults — symlinks under the project
  directory are followed; the symlink-cycle test pins that the
  resolver doesn't hang. Document via pinning test rather than
  reimplementing Turbo's distinction.

### Engine / scheduling

- **No executor batching.** Nx batches same-executor tasks into a
  single child process. vx's executor is a PLACEMENT seam — it decides
  where one command runs, never merges commands — so every task is its
  own process. Tradeoff: more spawn overhead; far simpler model.
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
