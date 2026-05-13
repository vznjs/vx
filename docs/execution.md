# Task execution lifecycle

This document traces what happens between `vx run build` typed at the
terminal and a task succeeding or failing. Read it alongside
[`architecture.md`](./architecture.md) (module map) and
[`caching.md`](./caching.md) (cache mechanics).

## End-to-end timeline

```
 ┌─ CLI dispatch (src/bin.ts → src/cli.ts → src/cli/run.ts)
 │    1. bin.ts spawns; forwards process.argv to cli.run().
 │    2. cli.ts dispatches by subcommand (run / cache / help / version).
 │    3. cli/run.ts:parseRunArgs(argv) → RunArgs (validated).
 │    4. cli/run.ts:runCmd resolves the project scope:
 │         - bare positionals respect --all / --filter / --affected / cwd
 │         - anchored positionals (pkg#task) target directly
 │         - no positionals + TTY → interactive picker → pkg#task
 │    5. Programmatic options are assembled and orchestrator.run() is
 │       called.
 │
 ├─ Workspace setup (src/orchestrator.ts:run)
 │    1. findWorkspaceRoot(cwd) — walks up; first match wins across
 │       pnpm-workspace.yaml, package.json with a `workspaces` field
 │       (npm/yarn/bun), or a bare package.json (single-project mode).
 │    2. loadWorkspace — parses the appropriate manifest. Bun.YAML
 │       for pnpm; Bun.file().json() for the package.json forms.
 │    3. loadWorkspaceConfig — optional vx.workspace.{ts,mts,js,mjs}
 │       at the root. Validates shape; returns null if absent.
 │    4. listProjects — globs every workspace member's package.json,
 │       finds sibling vx.config.* files, detects duplicate package
 │       names (hard error with both paths).
 │    5. loadProjectConfig — per project. Native Bun await import()
 │       with a content-hash query-string bust so config edits across
 │       same-process calls are picked up. Loader validates each
 │       TaskConfig shape (UserError on malformed).
 │    6. buildPackageGraph — workspace dep edges from package.json.
 │    7. computeNestedProjectDirs — set of projects rooted inside each
 │       project. Passed to every glob pass for boundary enforcement.
 │    8. computeWorkspaceFingerprint — sha256 over every supported
 │       lockfile + pnpm-workspace.yaml found at the root. Computed
 │       once; reused for every task's cache key.
 │
 ├─ Task selection (orchestrator.ts:expandRequested)
 │    Bare task names fan out across the resolved candidate projects
 │    (every project that declares the task). Anchored entries
 │    (`pkg#task`) resolve directly. Duplicates are deduped.
 │    Empty result → run returns `{ ok: false, outcomes: [] }` —
 │    no task is treated as a CI footgun.
 │
 ├─ Task graph (src/graph/task-graph.ts:buildTaskGraph)
 │    Starting from the resolved {project, task}[] pairs, walk
 │    dependsOn:
 │      - 'name'     → same-project task
 │      - '^name'    → task in every transitive workspace dep
 │      - 'pkg#name' → specific package's task
 │    Excluded edges (per --excludeDependencies) are dropped.
 │    Detect cycles — throws with the path.
 │    Each node carries: id (`${project}#${task}`), projectName,
 │    projectDir, taskName, config, sorted deps, `requested: boolean`
 │    (was this an explicit user request vs a dep-pulled expansion).
 │
 ├─ Cache construction
 │    1. new Cache(cacheDir) — local SQLite + on-disk v13 store.
 │    2. wrapWithRemoteCache(local, log) — when VX_REMOTE_CACHE_URL +
 │       _TOKEN are set, wraps in LayeredCache(local, remote).
 │    3. Either way, executeTask consumes the `CacheLayer` interface.
 │
 ├─ Run-level state
 │    • runId   — ULID stamped once per `vx run` invocation; every
 │                task in the resulting graph carries it.
 │    • runStartHrTimeNs — hrtime.bigint() anchor; per-task wallclock
 │                spans are stored relative to it.
 │    • persistentRegistry — Map<taskId, Subprocess> of long-running
 │                children. SIGTERMed at end-of-run.
 │
 ├─ Scheduling (src/graph/scheduler.ts:runGraph)
 │    Up to N tasks concurrently, ordered topologically.
 │    For each ready node: execute(node, upstream) → TaskOutcome.
 │    On failure: dependents are marked `skipped` (exit code 1,
 │      durationMs 0, no spawn); independent siblings keep running.
 │    The scheduler doesn't know about caching; the execute callback
 │    is the seam.
 │
 ├─ Per-task execution (src/orchestrator/execute-task.ts:executeTask)
 │    Each task takes one of three paths:
 │
 │    A. GROUP — no `exec`.
 │       Return success with a derived hash rolled up from upstream
 │       outcomes. No spawn, no I/O. Wallclock = 0.
 │
 │    B. PERSISTENT — `exec.persistent` set.
 │       1. Build isolated env (essentials + passThrough + define +
 │          <projectDir>/node_modules/.bin in PATH).
 │       2. runPersistent — Bun.spawn the command; subscribe to
 │          stdout/stderr line-by-line.
 │       3. Resolve `ready` when:
 │            - no readyWhen → immediately on spawn
 │            - readyWhen matches a line → on that line
 │            - child exits before either → reject with the captured stderr
 │       4. On ready: stash child in persistentRegistry; return
 │          success. Downstream tasks unblock.
 │       5. End-of-run: orchestrator SIGTERMs every registry entry
 │          and waits for exit.
 │       Note: cache + persistent is a config error (rejected by the
 │       project loader). Persistent tasks never write to cache.
 │
 │    C. NORMAL — `exec.command` only.
 │       1. resolveInputs(files, env)
 │            - glob inputs.files (gitignore-aware, declared-outputs-
 │              excluded, nested-projects-excluded)
 │            - read host process.env values for inputs.env names
 │       2. hashTaskConfig (resolved config JSON)
 │       3. hashProjectPackageJson (project package.json bytes)
 │       4. filterUpstreamHashes (apply cache.inputs.tasks filter)
 │       5. cache.key({ taskId, workspaceFingerprint,
 │                      projectPackageJsonHash, taskConfigHash,
 │                      envValues, inputFiles, upstreamHashes,
 │                      forwardArgs }) → hex sha256
 │       6. If cache is on AND `cache` block exists:
 │            cache.get(hash)
 │              · hit → cleanOutputs → restoreOutputs → replay logs →
 │                       return cache-hit (durationMs = restore op time)
 │              · miss → fall through; cleanOutputs first so a stale
 │                       prior build can't survive the fresh exec
 │       7. Build isolated env.
 │       8. runCommand → Bun.spawn shell with `command` + forwardArgs
 │          (shell-quoted). Buffer chunks via onStdout/onStderr (the
 │          logger flushes them as one framed block on completion).
 │       9. On exit 0 + cache enabled:
 │            resolveOutputs(outputs) → file list
 │            cache.save(...) — copy outputs into <hash>/outputs/<rel>,
 │              write <hash>/stdout + <hash>/stderr, upsert SQLite row.
 │      10. Return TaskOutcome { node, status, exitCode, durationMs,
 │            hash, stdout, stderr, cpuMs?, peakRssBytes?,
 │            wallclockStartNs, wallclockEndNs }.
 │
 └─ End-of-run
    1. SIGTERM every persistent child; Promise.allSettled their exits.
    2. Run summary (Tasks / Cached / Time) — counts only real tasks
       (with `exec`); group tasks don't pollute the totals.
    3. Optional --summarize JSON (default <cacheDir>/runs/<run_id>.json).
    4. Optional --profile Chrome-trace JSON (default profile.json).
    5. recordRun() once per executed task. Group tasks skipped.
    6. cache.close().
    7. Return { ok, outcomes }; ok = every real task ended success
       or cache-hit (any failed/skipped → ok = false → exit 1).
```

## One command per task

`exec.command` is a single shell command — there's no multi-step
sequence. Three ways to chain:

- **Shell composition** — `&&`, `;`, pipes. The shell is the API.
  ```ts
  exec: {
    command: 'gen && tsc && cp -r assets dist/'
  }
  ```
- **Separate tasks** linked by `dependsOn`:
  ```ts
  codegen: { exec: { command: 'gen' }, ... },
  build:   { exec: { command: 'tsc' }, dependsOn: ['codegen'], ... },
  ```
- **Group task** that fans out:
  ```ts
  release: {
    dependsOn: ['build', 'test', 'package']
  }
  ```

Per-task caching is the right granularity for invalidation. Splitting
gives you per-step caching naturally; combining with `&&` gives you
one cache slot for the whole chain.

## Env isolation

The child process gets, in priority order (lowest first):

1. **Essential allowlist** (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`,
   `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`,
   `NODE_OPTIONS`, plus Windows essentials like `SYSTEMROOT`).
2. **`exec.env.passThrough`** names → values from host `process.env`.
3. **`exec.env.define`** literal name/value pairs.
4. **PATH augmentation** — `<projectDir>/node_modules/.bin` is
   prepended so local tools (`oxlint`, `vite`, etc.) work without
   `npx`. Only the project's own bin; sibling-project bins stay
   invisible.

Anything not in these four layers is invisible to the child. This
prevents incidental env leakage between machines and gives
reproducible runs.

The allowlist + isolation contract lives in
[`modules/env.md`](./modules/env.md) and is the only field the
contract assumes for "what every command needs to function on
\*nix / Windows". Adding to the allowlist would be a deliberate
schema-extending change (consumer code expects a particular set;
broader access has cache-stability implications).

## Failure handling

| Failure                                                  | Behavior                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| Exec exits non-zero                                      | Task is `failed`; cache NOT written; live stream + outcome.stderr   |
| `execute()` throws (internal error)                      | Task marked `failed`; stderr written `[vx] internal error in <id>`  |
| Persistent task exits before ready                       | Task marked `failed`; outcome.stderr carries the captured output    |
| Upstream task fails                                      | Dependents marked `skipped` (exit 1, durationMs 0); no command runs |
| Workspace yaml missing                                   | `findWorkspaceRoot` throws (UserError); `vx run` exits 1            |
| Same-project task referenced in `dependsOn` not declared | `buildTaskGraph` throws with the offending edge                     |
| Duplicate workspace package name                         | `listProjects` throws with both paths                               |
| Cycle in task graph                                      | `detectCycle` throws with the cycle path                            |
| Malformed config                                         | `loadProjectConfig` throws (UserError) with file + field            |
| `--no-cache` AND outputs cleaned by user                 | Build is re-run from scratch; nothing read from cache               |

Failures don't kill the scheduler — independent tasks already in
flight finish, and unrelated tasks not yet started still run. The
overall exit code is 1 if any task ended in `failed` or `skipped`
status.

## Output capture and rendering

- **Buffered, framed.** `runCommand` listens to the child's
  stdout/stderr and calls `onStdout` / `onStderr` per chunk. The
  default logger buffers the chunks per-task and dumps the full body
  as a Turbo-style framed block on task completion. No per-line
  prefix, no interleaving between concurrent tasks.
- **Cache write.** Full stdout / stderr text is stored as
  `<hash>/stdout` and `<hash>/stderr` alongside the entry's outputs.
- **Cache hit replay.** The stored stdout / stderr is fed through the
  same logger path so the framed block looks the same as a fresh run.
- **Live stream for failures.** Even though cached output is not
  written for failures, the live stream means the user sees the
  failure as it happens; `TaskOutcome.stderr` carries the captured
  text for programmatic embedders.

There is no special handling for binary output, very large output, or
interactive prompts. Stdin is `'ignore'` (child sees a closed stdin)
— tasks that need TTY input won't work and shouldn't be cached anyway.

The colors / framing modules:

- `orchestrator/colors.ts` — ANSI truecolor (`ansi-16m`), gated by
  `NO_COLOR` / `FORCE_COLOR` / `isTTY`. Programmatic-logger callers
  always see plain text.
- `orchestrator/framed-output.ts` — the `┌─ task ─┐` borders.
- `orchestrator/logger.ts` — composes the two; surfaces per-task
  start, stdout, stderr, completion, status replay.
- `orchestrator/summary.ts` — the closing `Tasks / Cached / Time`
  block.

## Concurrency

- **Default** — `navigator.hardwareConcurrency` (Bun's CPU-count
  primitive), or `vx.workspace.ts`'s `concurrency` field when set.
- **Override** — `--concurrency N` or `-c N` (CLI). CLI wins over
  workspace config.
- **`concurrency: 1`** serializes execution while still respecting
  topo order.
- The scheduler never exceeds the cap; tasks queue.
- Failure of a task doesn't pause the scheduler — independent
  siblings continue running and starting.

## `--no-cache`

Bypasses cache reads **and** writes. Every task runs, and nothing is
persisted to the cache directory.

Useful when:

- You suspect cache corruption.
- You want to validate that a cache-hit task can re-run cleanly.
- You're benchmarking and need fresh timings.
- You're forwarding args via `--` and want a one-off run that doesn't
  populate the cache — though note that forwarded args are already in
  the key, so a separate entry would form anyway.

When `--no-cache` is set, **`cleanOutputs` is also skipped** — the
user is debugging and managing the tree themselves, and silently
wiping `dist/` mid-debug would be hostile.

`--cache` is accepted as a no-op for parity with vite-task.

## Planning paths (`--dry`, `--graph`)

Both short-circuit execution. The planner (`orchestrator/plan.ts`)
runs the same setup steps — workspace discovery, config load, package
graph, task graph — and the same per-task hash derivation, then
probes the cache (read-only — `cache.get` bumps `accessed_at` as a
side effect, which is fine).

The two flags differ only in output format:

- `--dry[=text|json]` → text (default) or JSON list of predicted
  outcomes per task: `would-cache-hit-local`,
  `would-cache-hit-remote`, `would-exec`, `no-cache`, `group`.
  Formatter: `orchestrator/plan-format.ts:formatPlanText` /
  `formatPlanJson`.
- `--graph[=<path>]` → Graphviz DOT, colored by predicted status.
  Pipe to `dot` for SVG/PNG render. Formatter:
  `formatGraphDot`.

Mutually exclusive: `--dry` and `--graph` together is a parse error.
Combining either with `--summarize` or `--profile` is a parse error
(those need a real run).

## Run artifacts

- **`--summarize[=<path>]`** — per-run JSON to
  `<cacheDir>/runs/<run_id>.json` by default (or the explicit path).
  Mirrors the `runs` table shape — one task entry per executed task
  with status, hash, duration, cpu_ms, peak RSS, hrtime spans
  (bigint serialized as strings to preserve ns precision).
- **`--profile[=<path>]`** — Chrome-trace JSON of every task's
  wallclock span. Default path: `profile.json` (cwd-relative). One
  `tid` per project so concurrent tasks render on distinct lanes.
  Open with `chrome://tracing` or https://ui.perfetto.dev.

Writers live in `orchestrator/run-artifacts.ts:writeRunSummary` /
`writeRunProfile`. Errors are surfaced to the user via `log.status`
but don't change the run's exit code — the run already happened.

## Why each rule

- **Cache failures are never cached.** Caching a failure prevents
  retry flows. The next run gets the same failure even after the
  user fixes the cause.
- **Group tasks are silent in the summary.** Including them in the
  count is confusing — "3 of 4 cached" when one was a group that
  ran nothing isn't informative.
- **Project scope defaults to cwd.** Most invocations are "build/
  test the thing I'm working on". `--all` / `--filter` exist for
  the workspace-wide case.
- **The scheduler doesn't bail on first failure.** A flaky test
  failing shouldn't stop an unrelated build. Independent siblings
  continue; only dependents are skipped.
- **Forwarded args don't reach upstream tasks.** Otherwise
  `vx run build -- --watch` would set `--watch` on every upstream's
  build, and upstream cache keys would partition by CLI args that
  don't change their behavior.
- **`recordRun` skips group tasks.** They aren't real runs;
  analytics queries that sum duration would double-count without it.
