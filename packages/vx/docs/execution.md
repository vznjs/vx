# Task execution lifecycle

This document traces what happens between `vx run build` typed at the
terminal and a task succeeding or failing. Read it alongside
[`architecture.md`](./architecture.md) (module map) and
[`caching.md`](./caching.md) (cache mechanics).

## End-to-end timeline

```
 ┌─ CLI dispatch (src/bin.ts → src/cli/index.ts → src/cli/run.ts)
 │    1. bin.ts spawns; forwards process.argv to cli.run().
 │    2. cli/index.ts dispatches by subcommand (run / watch / cache /
 │       lock / migrate / upgrade / show / info / mcp / help / version).
 │    3. cli/run.ts:parseRunArgs(argv) → RunArgs (validated; resolves
 │       the 4-axis cache policy from --cache / --no-cache / --force).
 │    4. cli/run.ts:runCmd resolves the project scope:
 │         - bare positionals respect --all / --filter / --affected / cwd
 │         - anchored positionals (pkg#task) target directly
 │         - no positionals + TTY → interactive picker → pkg#task
 │    5. The options map to RunOptions and the run executes IN THIS
 │       PROCESS — always. (A whole-run `backend` seam existed until
 │       2026-08; it moved the scheduler server-side, which is why it
 │       went. Per-task placement is the `executor` capability.)
 │       --dry / --graph short-circuit into planRun instead.
 │
 ├─ Prepare (src/orchestrator/prepare.ts:prepareRun — shared with planRun)
 │    1. findWorkspaceRoot(cwd) — walks up over pnpm-workspace.yaml,
 │       package.json with a `workspaces` field (npm/yarn/bun), or a
 │       bare package.json (single-project mode). The nearest one whose
 │       package globs CLAIM cwd wins, so running from inside a member
 │       resolves the declaring root, not the member; when nothing
 │       claims cwd the nearest candidate wins.
 │    2. loadWorkspace — parses the appropriate manifest. Bun.YAML
 │       for pnpm; Bun.file().json() for the package.json forms.
 │    3. loadWorkspaceConfig — optional vx.workspace.{ts,mts,js,mjs}
 │       at the root (concurrency / cacheDir / timeout / plugins).
 │    4. listProjects — globs every workspace member's package.json,
 │       finds sibling vx.config.* files, detects duplicate package
 │       names (hard error with both paths).
 │    5. SCOPED config loading — only in-scope projects plus their
 │       transitive dependency closure evaluate ('^task' frontier
 │       expansion never escapes the closure). Under --frozen, configs
 │       load from vx-lock.json after a content-hash tripwire — no
 │       evaluation, frozen-env semantics; a missing lock or entry is
 │       a hard UserError. Otherwise loadProjectConfig per project:
 │       native Bun await import() with a content-hash query-string
 │       bust; the loader validates each TaskConfig shape.
 │    6. buildPackageGraph — workspace dep edges from package.json.
 │    7. computeNestedProjectDirs — set of projects rooted inside each
 │       project, computed over EVERY config-bearing project (loaded
 │       or not) for boundary enforcement.
 │    8. computeWorkspaceFingerprint — xxh3 over every supported
 │       lockfile + pnpm-workspace.yaml found at the root. Computed
 │       once; reused for every task's cache key.
 │    9. expandRequested → buildTaskGraph (see below).
 │   10. Cache open: new Cache(cacheDir, { read, write }) with the
 │       policy's local slice. An injected RunOptions.remoteCache is
 │       composed into a LayeredCache (it wins); else a plugin's
 │       `cache` capability may wrap or replace it; else bare local.
 │   11. Bulk git populate — ONE `git ls-files -s --others` (plus one
 │       `git status --porcelain`) at the root fills the per-project
 │       GitFilesCache with file lists + index OIDs.
 ├─ Task selection (graph/task-graph.ts:expandRequested)
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
 │      - '^name'    → task in the nearest deps declaring it
 │                     (frontier walk; non-holders passed through)
 │      - 'pkg#name' → specific package's task
 │    Excluded edges (per --excludeDependencies) are dropped.
 │    Detect cycles — throws with the path.
 │    Each node carries: id (`${project}#${task}`), projectName,
 │    projectDir, taskName, config, sorted deps, `requested: boolean`.
 │    markSurfacedDeps then flags the display-only `surfaced` tasks a
 │    requested GROUP stands for (transparent folders).
 │
 ├─ Plugins + telemetry (src/orchestrator/run.ts)
 │    When vx.workspace.ts declares plugins:
 │      1. installPlugins — each plugin's optional setup() hook runs;
 │         a throw aborts the run with a clean UserError naming it.
 │      2. Run context capture — ONE git spawn (commit + branch; dirty
 │         reuses the GitFilesCache's status), CI-env detection,
 │         host/os/arch. Never fails a run.
 │      3. subscribeTelemetry — collects every plugin's TelemetrySink;
 │         with ZERO sinks it returns undefined and NOTHING subscribes
 │         (the no-telemetry hot path is byte-identical).
 │    With no plugins declared, all four steps are skipped entirely.
 │
 ├─ Run-level state
 │    • runId   — ULID stamped once per `vx run` invocation; every
 │                task in the resulting graph carries it.
 │    • runStartHrTimeNs — hrtime.bigint() anchor; per-task wallclock
 │                spans are stored relative to it.
 │    • persistentRegistry — Map<taskId, Subprocess> of long-running
 │                children.
 │    • liveChildren — Set<Subprocess> of in-flight children; the
 │                runner adds/removes each around its spawn.
 │    • SIGINT/SIGTERM handlers (removed in a finally): on signal,
 │                SIGTERM everything in liveChildren +
 │                persistentRegistry, close the cache, exit 128+signo
 │                (SIGINT → 130, SIGTERM → 143).
 │
 ├─ Cache acceleration (before scheduling)
 │    • REMOTE PREFETCH (LayeredCache runs only) — derive every
 │      stable-key cacheable task's key up front (reusing the run's
 │      hashCache memo) and fire the remote GETs in the background
 │      under a bounded pool. Not awaited before scheduling (the
 │      overlap is the point); drained before cache.close(). At most
 │      one remote GET per key (shared in-flight map with the lazy
 │      read-through).
 │    • LOCAL SHORT-CIRCUIT (local-only runs with local reads on and
 │      ≥1 dep edge) — derive the same stable keys and probe local
 │      cache.get ONCE per task → a `preProbed` map (hits AND stable
 │      misses; execute reuses these probes) + a `restoreTier` set
 │      (confirmed hits). Awaited before scheduling; never throws
 │      (degrades to the normal schedule).
 │
 ├─ Scheduling (src/graph/scheduler.ts:runGraph — two-tier)
 │    Up to N tasks concurrently over two ready queues:
 │      - EXEC tier — dep-gated; ready when every dep completed.
 │        Priority: transitive-reverse-dependent count (bitset
 │        closure), optionally overridden by a `priorities` map.
 │      - RESTORE tier — confirmed stable local hits; ready
 │        IMMEDIATELY (no dep gate, no failed-dep→skip check — their
 │        key is dep-independent) at LOW priority. The drain rule:
 │        exec-tier first, so misses own the worker pool and restores
 │        backfill idle capacity.
 │    On failure: exec-tier dependents are marked `skipped` (exit 1,
 │    durationMs 0, no spawn); independent siblings keep running.
 │    The scheduler doesn't know about caching; the execute callback
 │    is the seam. (A service run with a shared `inflight` map dedupes
 │    identical-hash tasks across concurrent runs here too.)
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
 │          stdout/stderr chunk-by-chunk.
 │       3. Resolve `ready` when:
 │            - no readyWhen → immediately on spawn
 │            - readyWhen matches the output (complete lines OR the
 │              trailing partial line) → on that match
 │            - child exits before either → reject with the captured
 │              stderr
 │            - exec.timeout elapses first → SIGTERM + fail
 │       4. On ready: stash child in persistentRegistry; return
 │          success. Downstream tasks unblock.
 │       Note: cache + persistent is a config error (rejected by the
 │       project loader). Persistent tasks never write to cache.
 │
 │    C. NORMAL — `exec.command` only.
 │       1. resolveInputs(files, env, runtime)
 │            - glob inputs.files (git-backed, declared-outputs-
 │              excluded, nested-projects-excluded)
 │            - glob inputs.workspaceFiles from the WORKSPACE ROOT
 │              (git-aware, NO boundary rule — the documented escape
 │              hatch); resolved paths join the same input list
 │            - read host process.env values for inputs.env names
 │            - resolve inputs.runtime / workspaceRuntime command
 │              output (deduped per run; non-zero exit fails the run)
 │       2. hashTaskConfig + project package.json hash (both memoized
 │          per run via HashCache)
 │       3. filterUpstreamHashes (apply cache.inputs.tasks filter)
 │       4. cache.key({ taskId, workspaceFingerprint,
 │                      projectPackageJsonHash, taskConfigHash,
 │                      forwardArgs, envValues, runtimeValues,
 │                      workspaceRuntimeValues, upstreamHashes,
 │                      inputFiles }) → 16-hex xxh3
 │          (Skipped when the local short-circuit pre-derived it.)
 │       5. If willRead (cache block + a read axis on):
 │            consume the up-front probe when present, else
 │            cache.get(hash)
 │              · hit → up-to-date short-circuit when the on-disk tree
 │                       already matches; else cleanOutputs →
 │                       restoreOutputs → replay stored stdout →
 │                       return cache-hit / cache-hit-remote
 │              · miss → fall through; cleanOutputs first (when
 │                       willWrite) so a stale prior build can't
 │                       survive the fresh exec
 │       6. Build isolated env.
 │       7. runCommand (or runSandboxed when `sandbox` is declared) →
 │          Bun.spawn shell with `command` + forwardArgs
 │          (shell-quoted). Buffer chunks via onStdout/onStderr.
 │          exec.timeout SIGTERMs an overrun → real `failed`, never
 │          cached. A child killed by a SHUTDOWN signal (Ctrl-C
 │          teardown) classifies as `aborted` instead — not counted,
 │          not recorded.
 │       8. On exit 0 + willWrite:
 │            resolveOutputs(outputs) + resolveWorkspaceOutputs →
 │              file lists
 │            a second computeTaskHash with captureInto records the
 │              per-component input fingerprint (miss-only; pure
 │              re-fold, no extra I/O)
 │            cache.save(...) — pack <hash>.tar.zst with stdout +
 │              outputs/<rel> (+ workspace-outputs/<rel-to-root>),
 │              upsert entries + output_files + entry_inputs rows in
 │              one transaction. Under a LayeredCache with remote
 │              writes on, the remote upload fires in the BACKGROUND
 │              (drained at end of run).
 │            markOutputsChanged — the project's git snapshot notes
 │              the written output paths so a same-project downstream
 │              task doesn't re-spawn git unless its globs overlap.
 │       9. Return TaskOutcome { node, status, exitCode, durationMs,
 │            hash, cpuMs?, peakRssBytes?, restored?,
 │            wallclockStartNs, wallclockEndNs }.
 │
 └─ End-of-run
    1. SIGTERM dependency-only persistent children; persistent tasks
       the user REQUESTED are kept alive (see below).
    2. Run summary footer (projects / tasks / cache meters + info +
       time) — counts only real tasks (with `exec`); group tasks
       don't pollute the totals; failure frames replay just above it.
    3. Optional --summarize JSON (default <cacheDir>/runs/<run_id>.json)
       and --profile Chrome-trace JSON (default profile.json).
    4. recordRunBundle — one transaction writing a `runs` row per real
       task plus the `invocations` header row (command, git/CI/host
       context, tags, counts). Group + aborted tasks skipped.
    5. Telemetry: emit the RunSummaryRecord to every active sink +
       await their flush (crash-isolated; skipped when no sink).
    6. Drain background remote prefetches/uploads; cache.close();
       sandbox teardown when any task was sandboxed.
    7. Return { ok, outcomes }; ok = every real task ended success
       or cache-hit (any failed/skipped → ok = false → exit 1).
    8. FOREGROUND ONLY: if the user requested a persistent task (a dev
       server), the process now blocks on its exit — the summary is
       already printed, `▸ <id> running` rows list what's alive, and
       Ctrl-C reaps the process group.
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

| Failure                                                  | Behavior                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exec exits non-zero                                      | Task is `failed`; cache NOT written; output streamed live + the failure frame replays at run end                                                                        |
| `exec.timeout` overrun                                   | SIGTERM; task is `failed` (timed out), exit 143, never cached                                                                                                           |
| Child killed by Ctrl-C teardown (SIGINT/SIGTERM)         | Task is `aborted` — not counted, not shown, not recorded                                                                                                                |
| `execute()` throws (internal error)                      | Task marked `failed`; stderr written `[vx] internal error in <id>` (a `UserError` reports plainly)                                                                      |
| Persistent task exits before ready                       | Task marked `failed`; the captured output is surfaced                                                                                                                   |
| Upstream task fails                                      | Dependents marked `skipped` (exit 1, durationMs 0); no command runs — EXCEPT a restore-tier task, whose confirmed cache hit still restores (its key is dep-independent) |
| Sandbox violation (macOS monitor / Linux structural)     | Task is `failed`; violations render in the frame; nothing cached                                                                                                        |
| Remote-cache error (500, timeout, corrupt artifact)      | Degrades to a cache miss; never fails the run                                                                                                                           |
| Workspace yaml missing                                   | `findWorkspaceRoot` throws (UserError); `vx run` exits 1                                                                                                                |
| Same-project task referenced in `dependsOn` not declared | `buildTaskGraph` throws with the offending edge                                                                                                                         |
| Duplicate workspace package name                         | `listProjects` throws with both paths                                                                                                                                   |
| Cycle in task graph                                      | `detectCycle` throws with the cycle path                                                                                                                                |
| Malformed config                                         | `loadProjectConfig` throws (UserError) with file + field                                                                                                                |
| `cache.inputs.runtime` command exits non-zero            | Hard UserError naming the command + exit code                                                                                                                           |

Failures don't kill the scheduler — independent tasks already in
flight finish, and unrelated tasks not yet started still run. The
overall exit code is 1 if any task ended in `failed` or `skipped`
status.

## Output capture and rendering

The orchestrator emits `RunEvent`s through an in-process bus; the
terminal renderer is the always-on subscriber (plugins, telemetry, and
wire forwarders attach beside it). What renders:

- **Flow-aware policy.** What gets rendered depends on the run's
  intent: FOCUSED (no selection flag) streams the requested task's
  output raw and live and silences successful dependencies; BROAD
  (`--all` / `--filter` / `--affected`) prints news only — one grid
  one-liner per executed task, failure frames replayed at run end,
  silence for cache hits; truthy `CI` env (and the programmatic
  default) keeps full grouped output. `--output-logs` overrides
  everything. Full table in [`cli.md`](./cli.md#output).
- **The glyph grid.** Reported task lines share one column grid —
  `<glyph> <time> <status> <cache> <name>`. Glyph SHAPE = cache axis
  (`⏺` miss / `►` fresh / `⇢` local / `⇣` remote / `◼` failed / `⊘`
  skipped / `▸` persistent); glyph COLOR + the status word = task axis
  (success / failed / skipped / running); the cache word (miss /
  fresh / local / remote) spells it out.
- **Buffered, framed (non-focused paths).** `runCommand` listens to
  the child's stdout/stderr and calls `onStdout` / `onStderr` per
  chunk. Outside focused streaming, the default logger buffers the
  chunks per-task and dumps the full body as a framed block on task
  completion. No per-line prefix, no interleaving between concurrent
  tasks.
- **Cache write.** Full stdout text is stored in the entry; replay is
  stdout-only (v17).
- **Cache hit replay.** The stored stdout is fed through the same
  logger path, so it renders per the active flow (streamed raw for a
  focused requested task, framed in full mode, silent in broad).
- **Live stream for failures.** Even though cached output is not
  written for failures, the live stream means the user sees the
  failure as it happens; the full frames replay together at run end,
  right above the summary.
- **Status region.** On TTY stdout outside CI, a multi-row region
  tracks the run live: a blank separator, pinned `▸` persistent rows,
  one row per worker slot (the ticking elapsed time IS the motion —
  no spinner), and the live summary section (the same meters as the
  final footer). Redrawn in place; forced redraws coalesce under a
  30 ms floor; erased before the summary prints. All default-logger
  writes serialize through one writer so content and the region never
  interleave.
- **GitHub Actions.** With `GITHUB_ACTIONS` truthy in full mode, task
  blocks collapse under `::group::` commands; failures stay open and
  emit `::error` annotations.

There is no special handling for binary output, very large output, or
interactive prompts. Stdin is `'ignore'` (child sees a closed stdin)
— tasks that need TTY input won't work and shouldn't be cached anyway.

Every surface uses one outcome vocabulary: task axis `success` /
`failed` / `skipped` / `aborted` (+ `running` live), cache axis
`miss` / `up-to-date` (fresh) / `local` / `remote`. The `--verbosity 1`
table and `--report` spell the combinations out as `executed` /
`restored-local` / `restored-remote` / `up-to-date`.

The colors / framing modules:

- `orchestrator/colors.ts` — ANSI truecolor (`ansi-16m`), gated by
  `NO_COLOR` / `FORCE_COLOR` / `isTTY`. Programmatic-logger callers
  always see plain text.
- `orchestrator/framed-output.ts` — the `┌─` frames, the glyph grid
  (`formatTaskRow`), one-liners, persistent markers.
- `orchestrator/status-line.ts` — the serialized writer + the worker
  region.
- `orchestrator/logger.ts` — composes them; resolves the output view
  and applies the per-flow visibility policy.
- `orchestrator/summary.ts` — the closing footer (wordmark rule,
  projects/tasks/cache meters, info + time rows).

## Concurrency

- **Default** — `navigator.hardwareConcurrency` (Bun's CPU-count
  primitive), or `vx.workspace.ts`'s `concurrency` field when set.
- **Override** — `--concurrency N` (CLI). CLI wins over workspace
  config.
- **`concurrency: 1`** serializes execution while still respecting
  topo order.
- The scheduler never exceeds the cap; tasks queue. Restore-tier
  tasks only take a slot no exec-tier task wants.
- Failure of a task doesn't pause the scheduler — independent
  siblings continue running and starting.

### Executor pools

`concurrency` counts LOCAL worker slots. An executor that runs its tasks
somewhere else declares its own `capacity`, and the tasks placed on it are
admitted against that number instead — so a 64-wide worker pool is not
throttled by a 10-core laptop, and a `--concurrency 1` run still keeps the
pool full.

- **Placement is decided once per task, before scheduling.** `run()` asks
  the declared executors, in order, which one takes each task (see
  [`schema.md` § `remote`](./schema.md#remote-optional) for what pins a
  task here); the scheduler then knows which pool every task will occupy.
- **A pooled task reserves no local resources.** `exec.resources` is a
  budget for THIS machine's CPU and RAM; a task running elsewhere spends
  neither, so it is admitted with a zero cost and can never park behind a
  local reservation.
- **Restore-tier tasks are always local** — a cache restore is a tar
  extract on this disk, so it takes a local slot regardless of where the
  task would have executed.
- **No pooled executor declared = the legacy path.** With every task on
  the local pool the admission gate is byte-identical to before pools
  existed.

## Cache control flags

`--no-cache` turns all four cache axes off: every task runs, nothing
is read or written, and `cleanOutputs` is skipped — the user is
debugging and managing the tree themselves; silently wiping `dist/`
mid-debug would be hostile.

`--force` turns only the READ axes off: every task re-executes, but
fresh artifacts are still written (outputs ARE cleaned so the saved
snapshot is clean). `--cache=<spec>` gives per-layer control. Full
semantics: [`cli.md` § Cache control](./cli.md#cache-control---cache---no-cache---force)
and [`caching.md` § Cache policy](./caching.md#cache-policy-readwrite-axes).

## Planning paths (`--dry`, `--graph`)

Both short-circuit execution. The planner (`orchestrator/plan.ts`)
runs the same setup steps — workspace discovery, config load, package
graph, task graph — and the same per-task hash derivation, then
probes the cache. The probe is read-only; against a remote layer it
is an existence check only (no artifact download, no ingest). The one
deliberate side effect: `cache.inputs.runtime` / `workspaceRuntime`
probe commands DO run, because predicting a key requires resolving
them — keep runtime inputs side-effect-free.

The two flags differ only in output format:

- `--dry[=text|json]` → text (default) or JSON list of predicted
  outcomes per task: `hit-local`, `hit-remote`, `miss`, `no-cache`,
  `group`. Formatter: `cli/plan-format.ts:formatPlanText` /
  `formatPlanJson`. When the workspace declares more than one executor,
  each line also names the executor the task would be PLACED on — the only
  surface that makes `exec.remote` checkable before the run. Resolving the
  executors is a plugin-factory call, the same class the cache capability
  already makes at plan time; a plugin that throws costs the label, never
  the plan.
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
- **`--report[=markdown]`** — a moon-style markdown table to stdout
  after the run (CI step summaries).

Writers live in `orchestrator/run-artifacts.ts:writeRunSummary` /
`writeRunProfile` and `orchestrator/run-report.ts`. Errors are
surfaced to the user via `log.status` but don't change the run's exit
code — the run already happened.

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
- **Misses own the worker pool.** A restore is cheap and can wait; a
  miss is the critical path. The restore tier exists so warm work
  never queues behind ordering it doesn't need — but it never steals
  a slot from real work.
- **Forwarded args don't reach upstream tasks.** Otherwise
  `vx run build -- --watch` would set `--watch` on every upstream's
  build, and upstream cache keys would partition by CLI args that
  don't change their behavior.
- **`recordRunBundle` skips group tasks.** They aren't real runs;
  analytics queries that sum duration would double-count without it.
- **A requested persistent task keeps the run alive.** The dev server
  IS the point of the run; tearing it down the instant it became
  ready would make `vx run dev` useless.
