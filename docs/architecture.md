# Architecture

This is the design map of `@vzn/vx`. Read it after
[`README.md`](./README.md) and before the per-module pages.

## Module map

`@vzn/vx` is a single-package project. Every module lives under
`src/`; each file is one focused module with a single responsibility.
Internal imports are unidirectional: lower modules in this map don't
depend on higher ones, so cycles are impossible by construction.

```
                          ┌────────────────┐
                          │     bin.ts     │   shebang entry; forwards process.argv → cli.run
                          └────────┬───────┘
                                   │
                          ┌────────▼───────┐
                          │     cli.ts     │   top-level dispatch
                          └────────┬───────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
       ┌────────▼─────────┐ ┌──────▼──────┐  ┌────────▼────────┐
       │   cli/run.ts     │ │ cli/cache   │  │   cli/help      │
       │   parser + flow  │ │ prune / TTL │  │   help text     │
       └────────┬─────────┘ └─────────────┘  └─────────────────┘
                │
       ┌────────▼─────────┐
       │ orchestrator.ts  │   run() / planRun(): workspace → graph → schedule
       └────────┬─────────┘
                │
     ┌──────────┴─────────────────────────────────────────┐
     │                                                    │
┌────▼───────────────┐                              ┌─────▼────────────────────┐
│ workspace/         │                              │ graph/                   │
│   workspace.ts     │  pnpm-workspace.yaml /       │   task-graph.ts          │  TaskNode DAG
│   project-loader.ts│  package.json workspaces /   │   scheduler.ts           │  parallel topo
│   package-graph.ts │  bare pkg.json discovery     │   dependency-spec.ts     │  shared parser
│   filter.ts        │  pnpm-style --filter DSL     └──────────────────────────┘
│   affected.ts      │  git-relative --affected
│   nested-dirs.ts   │  project-boundary set
│   fingerprint.ts   │  lockfile / workspace-yaml hash
└────────────────────┘
                │
        ┌───────▼───────────────────────────────────────────────────┐
        │  task lifecycle (orchestrator/* + cache/* + exec/*)        │
        │ ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
        │ │ execute-task    │ │ cache/inputs    │ │ exec/runner    │ │
        │ │  per-task glue  │ │  glob + boundary│ │  Bun.spawn     │ │
        │ ├─────────────────┤ ├─────────────────┤ ├────────────────┤ │
        │ │ upstream        │ │ cache/cache.ts  │ │ exec/env       │ │
        │ │ logger / colors │ │  SQLite + disk  │ │  allow-list    │ │
        │ │ framed-output   │ │ cache/layered   │ └────────────────┘ │
        │ │ summary         │ │ cache/remote    │                    │
        │ │ plan            │ │ cache/archive   │                    │
        │ │ run-artifacts   │ └─────────────────┘                    │
        │ │ remote-cache-setup                                       │
        │ └─────────────────┘                                        │
        └────────────────────────────────────────────────────────────┘

     config.ts:   the public schema (ProjectConfig, TaskConfig, ExecConfig, …)
     index.ts:    re-exports the public surface (defineProject, defineWorkspace, run, …)
     util/paths:  POSIX-path normaliser for stable cache keys across OSes
     util/ulid:   ULID generator for run_id stamping (no deps)
     util/errors: UserError — clean error reporting without a stack trace
```

### The cache cluster (`src/cache/`)

The cache is not a single file. It is composed:

- **`cache.ts`** — local v13 cache. `bun:sqlite` metadata index +
  on-disk entries at `<cacheDir>/<hash>/{outputs/, stdout, stderr}`.
- **`remote-cache.ts`** — Turborepo `/v8/artifacts/<hash>` HTTP client.
  Bearer-token authed; speaks the public protocol verbatim so it works
  against any compatible server.
- **`cache-archive.ts`** — bridges them. Packs / unpacks tar.gz so
  the remote layer can ship a single artifact per cache key.
- **`layered-cache.ts`** — composes local + remote behind the same
  `CacheLayer` interface (`key`, `get`, `restoreOutputs`, `save`,
  `recordRun`, `stats`, `prune`, `close`). Read-through (local then
  remote, hydrate local on remote hit); write-through (local sync,
  remote fire-and-forget so a remote outage doesn't fail the user's
  build).

The orchestrator constructs the local cache, then conditionally wraps
it via `wrapWithRemoteCache(localCache, log)` when
`VX_REMOTE_CACHE_URL` + `_TOKEN` are set. `executeTask` consumes the
`CacheLayer` surface and never branches on layering.

### Graph + scheduler

- **`graph/task-graph.ts`** — given the user's requested
  `(project, task)` pairs, walks `dependsOn` to build the full task
  DAG. Detects cycles. Each node carries an `id` (`${project}#${task}`),
  `projectName`, `projectDir`, `taskName`, sorted deps, a
  `requested: boolean` (was this an explicit user request vs. a
  dependsOn-expanded dep), and the resolved task config.
- **`graph/scheduler.ts`** — runs the DAG in topological order with
  up to N concurrent tasks. Failed tasks mark their dependents as
  `skipped`; independent siblings keep running. The scheduler is
  pure / ignorant of caching — it just receives an `execute(node, upstream)`
  callback and an outcome map.
- **`graph/dependency-spec.ts`** — shared Turbo/Nx micro-syntax parser
  (`'name'`, `'^name'`, `'pkg#name'`, plus `'*'` / `'^*'` / `'!form'`
  for filter contexts). Used by `task-graph` for `dependsOn` edges
  and by `orchestrator/upstream` for `cache.inputs.tasks` filtering.

### Runner

`exec/runner.ts` is the spawn primitive:

- **`runCommand`** — spawn the user's `exec.command` via `Bun.spawn`
  with `shell: true` so users get POSIX shell semantics (`&&`,
  redirects, pipes). Captures stdout/stderr via stream callbacks, awaits
  exit. On exit, calls `resourceUsage()` for `cpuMs` + `peakRssBytes`.
  Stdin is `'ignore'` — no TTY input. Forwarded args (`--`) are
  shell-quoted with `JSON.stringify(arg)` and appended.
- **`runPersistent`** — for dev servers + watchers. Spawns the command
  but does NOT await exit. Returns `{ ready, child, bufferedStdout(),
bufferedStderr(), readyMs() }`. `ready` resolves when a regex match
  appears in stdout/stderr (or immediately when no `readyWhen` is set).
  If the child exits before ready, `ready` rejects.

There is intentionally **no sandboxing layer**. Under-declared
`cache.inputs.files` will silently produce stale cache hits, which is
the standard task-runner tradeoff (Turbo and Nx behave the same).
A previous bwrap-based sandbox was removed (Ubuntu 24 default
AppArmor profile blocks unprivileged user namespaces, breaking it in CI).

## Data flow on `vx run <task>`

1. **`bin.ts`** spawns with the user's argv. Forwards everything
   after the binary name to `cli.run`.
2. **`cli.ts`** dispatches by subcommand: `run`, `cache`, `help`,
   `version`.
3. **`cli/run.ts:parseRunArgs`** parses the argv into a `RunArgs`
   object. Surfaces parse errors as `RunArgs.error` so the caller
   prints + exits before doing any I/O.
4. **`cli/run.ts:runCmd`** resolves the project scope:
   - Bare positionals (`build`) honour `--all` / `--filter` /
     `--affected` / default-to-cwd.
   - Anchored positionals (`pkg#build`) bypass the scope and target
     directly.
   - `--affected[=<base>]` is sugar for an extra filter `[<base>]`
     resolved via git.
   - No positionals + TTY → interactive picker → emits a single
     `pkg#task`.
5. **`orchestrator.ts:run()`** is called with `RunOptions`. From here:
   1. `findWorkspaceRoot(cwd)` walks up looking for any of:
      `pnpm-workspace.yaml`, `package.json` with a `workspaces` field
      (npm / yarn / Bun), or a bare `package.json` (single-project mode).
      First match wins.
   2. `loadWorkspace(root)` parses the appropriate manifest
      (`Bun.YAML` for pnpm; `Bun.file().json()` otherwise).
   3. `loadWorkspaceConfig(root)` loads optional `vx.workspace.ts`
      (concurrency + cacheDir overrides). Schema-validated.
   4. `listProjects(workspace)` globs every workspace member's
      `package.json`, finds a sibling `vx.config.{ts,mts,js,mjs}`,
      detects duplicate names (hard error).
   5. `loadProjectConfig(configPath)` per project. Native Bun
      `await import()` with a content-hash query string
      (`?vx-bust=<sha256>`) so config edits across same-process calls
      are picked up. The full project config object is captured.
   6. `buildPackageGraph(projects)` builds workspace dep edges from
      each project's `package.json`. Workspace-internal deps only.
   7. `computeNestedProjectDirs(projects)` precomputes, per project,
      the set of other projects' directories that live underneath it.
      Passed to every glob pass so a parent project's `inputs.files`
      can never reach into a nested project.
   8. `computeWorkspaceFingerprint(root)` hashes every supported
      lockfile + `pnpm-workspace.yaml` at the root. One value reused
      across every task in the run.
   9. `expandRequested(tasks, candidates, projects)` turns the user's
      task list into a concrete `(project, task)[]`. Bare names fan
      out across `candidates`; anchored entries pass through.
   10. `buildTaskGraph({ projects, packageGraph, requested,
excludeDependencies? })` walks `dependsOn` into the full DAG
       and detects cycles.
   11. `new Cache(cacheDir)` opens the local SQLite cache; if the
       remote-cache env is present, `wrapWithRemoteCache` returns a
       `LayeredCache(local, remote)`. Either way, `executeTask` sees
       a single `CacheLayer`.
   12. `runGraph({ nodes, concurrency, execute, … })` runs the DAG.
       Each ready node invokes `executeTask({ node, upstream, … })`
       (described below).
   13. After the graph drains, every persistent subprocess is
       `SIGTERM`ed in parallel (via the registry).
   14. Optional artifacts: `--summarize` (per-run JSON to
       `<cacheDir>/runs/<run_id>.json`) and `--profile` (Chrome-trace
       JSON to `profile.json`).
   15. One `recordRun()` per executed task — appends to the `runs`
       analytics table. Group tasks are skipped.
   16. `cache.close()`.
6. **`orchestrator/execute-task.ts:executeTask`** per task:
   1. **Group task short-circuit** — no `exec` → return `success`
      with a hash rolled up from upstream (so downstream caches still
      invalidate when anything beneath the group changes). No I/O.
   2. **Persistent task** — spawn, wait for `readyWhen` match (or
      immediate ready when omitted). Stash the child handle in the
      registry. Return `success` once ready; orchestrator SIGTERMs
      at the end of the run.
   3. **Normal task**:
      a. `resolveInputs` — glob `cache.inputs.files`, gitignore-aware,
      declared-outputs-excluded, nested-projects-excluded. Read
      host values for `cache.inputs.env`.
      b. `filterUpstreamHashes` — apply `cache.inputs.tasks` filters
      to the upstream outcomes (default = all upstream).
      c. `hashTaskConfig` (resolved config JSON) +
      `hashProjectPackageJson` (project package.json bytes).
      d. `cache.key({...})` → hex sha256.
      e. If caching is on: `cache.get(hash)`. On hit, `cleanOutputs`
      - `restoreOutputs` + replay captured logs → `cache-hit`. The
        entry's `source: 'local' | 'remote'` distinguishes local vs.
        remote replays.
        f. On miss + caching enabled: `cleanOutputs` first, so stale
        files from a previous build can't survive a fresh exec.
        g. `buildIsolatedEnv` — essential allowlist + `passThrough`
        host values + `define` literals + `<projectDir>/node_modules/.bin`
        prepended to PATH.
        h. `runCommand` — `Bun.spawn` shell with the command + forwarded
        args. Captures stdout / stderr / cpu / RSS.
        i. On `exitCode === 0` + caching: `resolveOutputs` + `cache.save`.
        Otherwise nothing is cached (cached failures would prevent
        retry flows).
        j. Return a `TaskOutcome` with hrtime spans relative to the
        run's `t=0` anchor.

## The project loader & the config-time imports problem

`workspace/project-loader.ts` loads each `vx.config.{ts,mts,js,mjs}`
via Bun's native `await import()` — no jiti, no esbuild, no
transpile-on-load step. We append a content-hash query string
(`?vx-bust=<sha256>`) to the import specifier so:

- Same content → same URL → Bun's module cache hits (fast).
- Changed content → new URL → fresh re-evaluation (correct).

The loader validates each task's shape at load time and surfaces a
`UserError` (clean output, no stack) on malformed configs. Among the
rules enforced: `exec.persistent` rejects malformed shapes; a
persistent task with a `cache` block is rejected (no exit to cache);
group tasks (no `exec`) must declare `dependsOn`; `cache.inputs.files`
and `cache.outputs.files` are required when `cache` is set.

### Config-time imports & the bootstrap problem

`vx.config.ts` is regular TypeScript. It can import anything Bun can
resolve — npm packages, relative files, workspace siblings. This is
the headline UX win over Turbo's static JSON.

It also creates a chicken-and-egg risk: a config that imports a
workspace package whose `main` points to a built `dist/` won't load
until that package is built — but the package's build itself runs
through vx, which needs the config to load first. The same shape
appears with Nx executor plugins (they're npm packages that themselves
need a build).

**vx's pragmatic resolution: rely on Bun's TypeScript-native imports.**
A workspace package consumed at config-load time should resolve to its
`.ts` source, not to a built artifact:

```jsonc
// packages/preset/package.json
{
  "name": "@org/preset",
  // Source-first: Bun runs the .ts directly. No build needed for
  // config-time consumers. (If you also publish to npm, use an
  // `exports` map with `node` / `default` conditions to ship the
  // built JS to external consumers while keeping source for the
  // workspace.)
  "main": "./src/index.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "default": "./dist/index.js",
    },
  },
}
```

This sidesteps bootstrap entirely: importing the preset just evaluates
the source on demand.

A **bootstrap mode** — vx detects that an import resolves to a
workspace package and runs its `build` task before continuing — is
technically possible but was rejected:

1. It's recursive: the preset's own `vx.config.ts` could import
   another preset, requiring another bootstrap. Termination requires
   either declaring a special "tooling" preset class that doesn't
   participate, or scanning a fixed prefix of the import graph at
   load time. Either choice leaks a magic rule.
2. It collapses two distinct phases of the run (config load → task
   graph build → task execute) into one mutual recursion, making
   the `--dry` / `--graph` planning paths conceptually fuzzier.
3. Bun's TS-source-import already covers the common case for
   essentially zero cost. Forcing a bootstrap path is a heavyweight
   solution to a problem the runtime already solves.

The tradeoff: if your preset MUST ship as built JS (e.g. a third-party
team publishes only `dist/` and you can't influence the package), you
have two options that don't require bootstrap:

- Build it out-of-band with `tsc` / `tsdown` directly — no vx involved,
  so no cycle.
- Use package.json `exports` conditions to keep `.ts` for workspace
  consumers and built `.js` for everyone else (recommended).

## Replaceability contract

Every module is structured so swapping it touches that module's `.ts`
file plus its consumers' imports — no behavioural ripple. The
[`modules/`](./modules/) docs list each module's public types and
functions; those are the seam. Internal helpers can change.

| Module                        | Replace it to…                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| `workspace/workspace.ts`      | Support different workspace layouts (lerna, rush, custom yaml)        |
| `workspace/project-loader.ts` | Use a non-Bun TS loader (esbuild, swc, native Node tsx)               |
| `workspace/filter.ts`         | Replace the filter DSL surface (e.g. with Nx `--projects` semantics)  |
| `workspace/affected.ts`       | Replace git-relative selection (Mercurial, Jujutsu, build-graph diff) |
| `graph/task-graph.ts`         | Different graph-build semantics (priority, time-cost weighting)       |
| `graph/scheduler.ts`          | Work-stealing, priority queues, distributed execution                 |
| `cache/cache.ts`              | Different local store (per-entry manifests, BLOB-in-SQLite, S3-local) |
| `cache/remote-cache.ts`       | Different remote backend (raw S3, HMAC-signed protocol)               |
| `cache/cache-archive.ts`      | Swap tar.gz for zstd, zip, JS-native pack                             |
| `cache/layered-cache.ts`      | Different layering (local → regional → global; warm-cache prefetch)   |
| `exec/runner.ts`              | Spawn into containers / remote builders                               |
| `exec/env.ts`                 | Adjust isolation policy (broader allowlist, OS-specific essentials)   |
| `cache/inputs.ts`             | fspy-style auto-input inference (LD_PRELOAD / Detours / unotify)      |
| `orchestrator/logger.ts`      | Plain-text logger, JSON-line logger, observability emitter            |

## Remote-cache subsystem (detail)

`vx run` reads `VX_REMOTE_CACHE_URL` + `VX_REMOTE_CACHE_TOKEN` at the
top of `orchestrator.run()`. When both are present:

1. `wrapWithRemoteCache(localCache, log)` constructs a `RemoteCache`
   with the URL, token, and optional `teamId` / `slug` / `timeoutMs`
   (from `VX_REMOTE_CACHE_TEAM_ID`, `_SLUG`, `_TIMEOUT_MS`).
2. Wraps it via `new LayeredCache(localCache, remoteCache)`.
3. Logs `remote cache: <url>` so the user knows it's active.

Reads try local first, then remote (hydrating local on remote hit).
Writes go to local synchronously, then pack + PUT to remote in the
background. Remote errors fire `onRemoteError` (logged) but never
throw — the user's task already succeeded; a flaky cache server
shouldn't fail the build.

The wire spec is Turborepo `/v8/artifacts/{hash}` verbatim, so the
client interops with any Turbo-compatible server
(`ducktors/turborepo-remote-cache`, `Fox32/openturbo-remote-cache`,
Vercel's hosted cache). The **tar interior** is ours — `outputs/`
plus stdout/stderr alongside — not Turbo's specific layout. Since
servers don't inspect the payload, the difference is invisible to
them. See [`design/remote-cache.md`](./design/remote-cache.md) for
the wire-level details and the open HMAC-signing workstream.

## Run-history analytics

Every `vx run` invocation stamps a ULID (`run_id`) and appends one
row per executed task to the `runs` table in `cache.db`. Columns:

| Column                                    | What                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `hash`                                    | The task's cache key                                                |
| `project, task`                           | `${project}#${task}` split                                          |
| `status`                                  | `success` / `failed` / `cache-hit` / `cache-hit-remote` / `skipped` |
| `exit_code`                               | from the child or 0 for cache-hits                                  |
| `duration_ms`                             | wallclock the user perceived (cache-hit = restore op time)          |
| `forward_args`                            | JSON-encoded `--` args (null when none)                             |
| `started_at, ended_at`                    | ms-epoch wallclock                                                  |
| `run_id`                                  | ULID shared across every task in the same invocation                |
| `cpu_ms`                                  | `Bun.spawn` resource-usage CPU (sum of user + system)               |
| `peak_rss_bytes`                          | resource-usage max RSS                                              |
| `wallclock_start_ns` / `wallclock_end_ns` | hrtime ns relative to run t=0                                       |
| `cache_hit`                               | convenience boolean (derivable from status)                         |
| `bytes_uploaded` / `bytes_downloaded`     | remote-cache push / pull sizes                                      |

Group tasks (no `exec`) are deliberately not recorded — they aren't
real runs. Failed tasks ARE recorded for postmortem (the `status` +
`exit_code` columns capture the failure).

The same per-task wallclock has three surface forms today:

| Surface            | Where                                              | When written          |
| ------------------ | -------------------------------------------------- | --------------------- |
| `runs` table       | `<cacheDir>/cache.db`                              | every `vx run` end    |
| `--summarize` JSON | `<cacheDir>/runs/<run_id>.json` (or explicit path) | opt-in per invocation |
| `--profile` trace  | `profile.json` (or explicit path)                  | opt-in per invocation |

The summarize JSON mirrors the `runs` table shape; the profile JSON is
Chrome-trace format (one `ph: 'X'` event per task with `ts` and `dur`
in microseconds, one `tid` per project so overlapping tasks render on
distinct lanes — open in `chrome://tracing` or
https://ui.perfetto.dev). See
[`cli.md` § Run artifacts](./cli.md#run-artifacts---summarize---profile).

CI scripts that want live numbers can `sqlite3 cache.db` directly. No
HTTP layer, no UI — the cache file IS the API.

## Design principles

The codebase consistently chooses the same trade-offs:

1. **Explicit over magical.** Defaults exist but are narrow and
   documented. Where ambiguity is dangerous (cache inputs, outputs,
   env isolation), declaration is required. `cache.inputs.files` has
   no default; you state what the task reads.
2. **One command per task.** `exec: { command }` runs a single shell
   command. To chain steps, use shell composition (`&&`, `;`) or split
   into separate tasks linked by `dependsOn`. Splitting gives you
   per-step caching for free.
3. **Shell is the API.** Commands are strings; the shell is the
   integration boundary. No JS-function tasks; no executor plugin
   protocol. Presets are TypeScript helpers that _return_ `TaskConfig`
   objects, evaluated at config-load time.
4. **Resolved values, not source bytes.** The cache key derives from
   the _evaluated_ config object, not from the file's text. Imports
   and computed values participate naturally.
5. **Cascade through the dependency graph.** Upstream cache changes
   invalidate dependents via folded-in upstream hashes; workspace-
   level changes (lockfile, workspace yaml) cascade to every task
   via the workspace fingerprint.
6. **Fail loud on the contract.** Cache key shape change → bump
   `CACHE_VERSION`. Schema mismatch on the SQLite tables → drop and
   rebuild. Don't try to be clever with stale data.
7. **Trust internal code; validate at boundaries.** The TypeScript
   types are the contract between modules. Only user input (argv,
   config files, env vars) and external APIs (remote cache) get
   runtime shape checks.
8. **No comments restating the code.** Comments exist only when
   removing them would confuse a future reader. They explain _why_,
   not _what_.

## What's intentionally absent

See [`README.md` § Out of scope](./README.md#out-of-scope-by-design)
for the complete list. The most relevant ones for understanding the
architecture:

- **No plugin protocol.** A plugin protocol introduces versioned
  packages, a stable plugin ABI, dependency-graph headaches, and
  runtime indirection. Presets-as-imports get most of the benefit at
  none of the cost.
- **No daemon.** Every `vx run` is a fresh process. Workspace
  re-discovery + config evaluation is cheap enough on Bun that a
  daemon doesn't pay for itself. (Concretely: a small workspace
  re-discovers in tens of ms.)
- **No nested task graphs.** The unit of caching, scheduling, and
  reporting is the task. For parallelism, define separate tasks
  linked by `dependsOn`. For chained commands inside one task, use
  shell composition in `exec.command`.
- **No sandboxing.** Under-declared inputs produce stale cache hits;
  that's the accepted tradeoff. Turbo and Nx behave the same. A
  bwrap-based sandbox was tried and reverted (Ubuntu 24's default
  AppArmor profile blocks unprivileged user namespaces, breaking it
  in CI).
- **No watch mode** (yet). Per-tool watchers (Vite, tsc -b -w,
  bun --watch) do this well already.
