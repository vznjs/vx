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
 │       lock / init / upgrade / show / info / why / last /
 │       completions / help / version); any other verb is asked of the
 │       workspace's plugins (`commands` seam — `vx mcp` is one).
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
 │       resolves the declaring root, not the member; the first
 │       directory holding pnpm-workspace.yaml stops the walk whether
 │       or not its globs claim cwd (pnpm's rule); when nothing claims
 │       cwd the nearest candidate wins. An UNSCOPED run (no explicit
 │       project scope, at least one bare task name) then starts
 │       step 12's git enumeration over the whole tree, overlapping
 │       steps 2–11; a scoped run waits, since its pathspecs depend on
 │       which projects the task graph holds.
 │    2. loadWorkspace — parses the appropriate manifest. Bun.YAML
 │       for pnpm; the package.json forms read as bytes (readOnce,
 │       shared with step 1) and JSON.parse.
 │    3. loadWorkspacePlugins — loadWorkspaceConfig reads the optional
 │       vx.workspace.{ts,mts,js,mjs,cts,cjs} at the root (concurrency /
 │       cacheDir / timeout / cacheRetention / affectedBase / cacheScope /
 │       rules / plugins),
 │       then the plugin `config` stage runs on it.
 │    4. listProjects — globs every workspace member's package.json,
 │       finds sibling vx.config.* files, detects duplicate package
 │       names (hard error with both paths).
 │    5. buildPackageGraph — workspace dep edges from package.json.
 │    6. Local cache open: new Cache(cacheDir, { read, write }, root)
 │       with the policy's local slice — BEFORE the configs load,
 │       because it also holds their cached evaluations. Then
 │       computeWorkspaceFingerprints: one read of every supported
 │       lockfile + pnpm-workspace.yaml + .yarnrc.yml + .npmrc + bunfig.toml at the root
 │       yields `all` (every file; keys the config-evaluation cache),
 │       `unclaimed` (minus the files a `fingerprint` plugin claims —
 │       `@vzn/vx-lockfile` keys those per project; reused for every
 │       task's cache key) and `files` (the bytes, for the mid-run
 │       fingerprint check).
 │    7. SCOPED config loading — only in-scope projects plus their
 │       transitive dependency closure evaluate ('^task' frontier
 │       expansion never escapes the closure); one staged load,
 │       loadProjects, shared with every reading verb. Under --frozen,
 │       configs load from vx-lock.json — no evaluation, no staleness
 │       check of its own (vx lock --check is the audit), frozen-env
 │       semantics; a missing lock or entry is a hard UserError.
 │       Otherwise loadProjectConfigs in one batch: native Bun await
 │       import() with a content-hash query-string bust, cached
 │       evaluations served for pure configs; the loader validates
 │       each TaskConfig shape, and the plugin `project` stage runs
 │       on each config with a re-validation after every plugin.
 │    8. computeNestedProjectDirs — set of projects rooted inside each
 │       project, computed over EVERY config-bearing project (loaded
 │       or not) for boundary enforcement.
 │    9. expandRequested (see Task selection below).
 │   10. Cache layer: an injected RunOptions.remoteCache is composed
 │       with the local cache into a LayeredCache (it wins); else
 │       resolveCache lets a plugin's `cache` capability wrap or
 │       replace it; else bare local.
 │   11. buildTaskGraph (see below).
 │   12. Bulk git populate — the enumeration step 1 started is
 │       awaited, or a scoped run starts it here over the projects
 │       that own a task (not the dependency closure step 7 loaded,
 │       which a `lint` of one package does not key). THREE spawns at
 │       the root, concurrent, and the repository's facts asked while
 │       they run (`ls-files -s -v -z` for the index: every tracked
 │       path's OID and its cache-state flag;
 │       `status --porcelain -z -uall` for
 │       the dirty AND untracked sets, the one worktree walk; `var -l`
 │       for core.autocrlf and the attributes files git reads outside
 │       the tree; the facts — prefix, common dir, object format, index
 │       file — read off a plain `.git` directory, else one
 │       `rev-parse --show-prefix --git-common-dir --show-object-format
 │       --git-path index`,
 │       memoized per process and shared with the file hasher)
 │       fill the per-project GitFilesCache with file lists + index
 │       OIDs. `ls-files --others` is NOT among them — status's
 │       `-uall` already answers untracked, and asking git twice
 │       walked the same tree again. A fifth, `check-attr`, runs only
 │       when an attributes file could rewrite bytes. An index the
 │       cache holds no blob-size verdict for (keyed by the index
 │       file's hash, A-60) adds `ls-files --debug` for the recorded
 │       sizes and `cat-file --batch-check` for the blob sizes
 │       `blob_sizes` lacks: an OID whose blob is not the recorded size
 │       is not trusted. The run's HashCache is created
 │       after it.
 ├─ Task selection (graph/task-graph.ts:expandRequested)
 │    Bare task names fan out across the resolved candidate projects
 │    (every project that declares the task). Anchored entries
 │    (`pkg#task`) resolve directly. Duplicates are deduped.
 │    Empty result → run returns `{ ok: false, outcomes: [] }` —
 │    no task is treated as a CI footgun. The exception: a diff-scoped
 │    run (--affected) whose task names are all declared by projects
 │    outside the selection is `none-affected` and returns
 │    `{ ok: true, outcomes: [] }`.
 │
 ├─ Task graph (src/graph/task-graph.ts:buildTaskGraph)
 │    Starting from the resolved {project, task}[] pairs, walk
 │    dependsOn:
 │      - 'name'     → same-project task
 │      - '^name'    → task in the nearest deps declaring it
 │                     (frontier walk; non-holders passed through)
 │      - 'pkg#name' → specific package's task
 │    Detect cycles — throws with the path. After the graph and key
 │    stages, excluded edges (per --exclude-dependencies[=names]) leave
 │    the SCHEDULE; each dropped task is still keyed and folded into
 │    its dependant (orchestrator/excluded-keys.ts).
 │    Each node carries: id (`${project}#${task}`), projectName,
 │    projectDir, taskName, config, sorted deps, `requested: boolean`.
 │    markSurfacedDeps then flags the display-only `surfaced` tasks a
 │    requested GROUP stands for (transparent folders).
 │
 ├─ Plugins + telemetry (src/orchestrator/run.ts)
 │      1. installPlugins — always called; each plugin's optional
 │         setup() hook runs; a throw aborts the run with a clean
 │         UserError naming it. With no plugins it runs nothing.
 │      2. Run context capture — always, for the `invocations` row:
 │         commit + branch read from `.git` directly, `git rev-parse`
 │         only when that reader does not understand the layout; dirty
 │         reuses the GitFilesCache's status; CI-env detection,
 │         host/os/arch. Never fails a run.
 │      3. Telemetry — only when a plugin has a `telemetry` hook or
 │         RunOptions.telemetrySinks is passed: the run-context record
 │         (adding captureWorkspaceIdentity) is built and
 │         subscribeTelemetry collects the sinks; with ZERO sinks it
 │         returns undefined and NOTHING subscribes (the no-telemetry
 │         hot path is byte-identical).
 │
 ├─ Run-level state
 │    • runId   — UUIDv7 stamped once per `vx run` invocation; every
 │                task in the resulting graph carries it.
 │    • runStartHrTimeNs — hrtime.bigint() anchor; per-task wallclock
 │                spans are stored relative to it.
 │    • persistentRegistry — Map<taskId, Subprocess> of long-running
 │                children.
 │    • liveChildren — Set<Subprocess> of in-flight children; the
 │                runner adds/removes each around its spawn.
 │    • SIGINT/SIGTERM/SIGHUP handlers (removed in a finally): on
 │                signal, forward it (SIGHUP as SIGTERM) to everything
 │                in liveChildren + persistentRegistry (and kill any
 │                running cache.inputs.runtime probe, C-65), wait
 │                VX_KILL_GRACE_MS (2 s) for their groups, SIGKILL
 │                what is still there, let the run finish its own
 │                end (flush, teardown, cache close), then
 │                exit 128+signo (SIGINT → 130, SIGTERM → 143,
 │                SIGHUP → 129). SIGHUP is registered because a task
 │                runs in its own session, so a closing terminal
 │                reaches vx and nothing else. A second signal
 │                SIGKILLs and exits at once.
 │
 ├─ Cache acceleration (before scheduling)
 │    • REMOTE PREFETCH (a cache layer with a remote only) — derive every
 │      stable-key cacheable task's key up front (reusing the run's
 │      hashCache memo) and fire the remote GETs in the background
 │      under a bounded pool. Not awaited before scheduling (the
 │      overlap is the point); drained before cache.close(). At most
 │      one remote GET per key (shared in-flight map with the lazy
 │      read-through).
 │    • LOCAL SHORT-CIRCUIT (no remote layer, local reads on, ≥1
 │      task) — derive the same stable keys and probe them in ONE
 │      batched cache.getMany (a layer without getMany: cache.get once
 │      per task under a bounded pool) → a `preProbed` map (hits AND
 │      stable misses; execute reuses these probes) + a `restoreTier`
 │      set (confirmed hits). Awaited before scheduling; never throws
 │      (degrades to the normal schedule).
 │
 ├─ Scheduling (src/graph/scheduler.ts:runGraph — two-tier)
 │    Two ready queues, each on its own lane:
 │      - EXEC tier — dep-gated; ready when every dep completed; up
 │        to N (concurrency) at once.
 │        Priority: transitive-reverse-dependent count (bitset
 │        closure), optionally overridden by a `priorities` map.
 │      - RESTORE tier — confirmed stable local hits; ready
 │        IMMEDIATELY (no dep gate, no failed-dep→skip check — their
 │        key is dep-independent) at LOW priority, on a restore lane
 │        of 2×N. The drain rule: exec-tier first; a restore never
 │        takes an exec slot and the two lanes never wait on each
 │        other — except at N = 1, where they share the one slot.
 │    On failure: exec-tier dependents are marked `skipped` (exit 1,
 │    durationMs 0, no spawn); independent siblings keep running.
 │    The scheduler doesn't know about caching; the execute callback
 │    is the seam. (An embedder running concurrent runs in one process
 │    may pass a shared `inflight` map; admission.ts then dedupes
 │    identical-key tasks across them. A plain `vx run` passes none.)
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
 │          <projectDir>/node_modules/.bin, then
 │          <workspaceRoot>/node_modules/.bin, prepended to PATH).
 │       2. runPersistent — Bun.spawn the command; subscribe to
 │          stdout/stderr chunk-by-chunk.
 │       3. Resolve `ready` when:
 │            - no readyWhen → immediately on spawn
 │            - readyWhen matches the output (complete lines OR the
 │              trailing partial line) → on that match
 │            - child exits before the match → reject with
 │              PersistentReadyError('persistent task exited before
 │              becoming ready (exit N)'); its output already streamed
 │              through the logger
 │            - readyWhen set and the timeout (exec.timeout, else the
 │              run default) elapses first → fail, SIGTERM, SIGKILL
 │              after the grace
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
 │              output (deduped per run; a non-zero exit throws a
 │              UserError that fails this task — its dependents skip,
 │              independent tasks continue)
 │       2. hashTaskConfig + project package.json hash (both memoized
 │          per run via HashCache)
 │       3. filterUpstreamHashes (apply cache.inputs.tasks filter)
 │       4. cache.key({ taskId, workspaceFingerprint,
 │                      projectPackageJsonHash, taskConfigHash,
 │                      forwardArgs, envValues, runtimeValues,
 │                      workspaceRuntimeValues, upstreamHashes,
 │                      pluginParts, inputFiles }) → 16-hex xxh3
 │          (pluginParts is whatever the `key` stage contributed,
 │          folded between the upstream keys and the input files —
 │          see caching.md § Cache key derivation for the order.)
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
 │       6. Build isolated env. For a cacheable task,
 │          describeTaskInputs({ captureInto }) then describes the input
 │          set ONCE, before the spawn: the executor gets the input
 │          values and the save reuses the captured per-component input
 │          fingerprint (a re-fold over the memos, no I/O).
 │       7. runCommand (or runSandboxed when `sandbox` is declared) →
 │          Bun.spawn shell with `command` + forwardArgs
 │          (shell-quoted). Buffer chunks via onStdout/onStderr.
 │          exec.timeout SIGTERMs an overrun → real `failed`, never
 │          cached. An attempt that ends while the run is STOPPING
 │          (Ctrl-C teardown) classifies as `aborted` instead, whatever
 │          its exit — not counted, not recorded, not retried.
 │       8. On exit 0 + willSave (willWrite, no tainted upstream):
 │            keyStillTrue() — if the workspace fingerprint or an
 │              input moved since the key was taken, the result stands
 │              but the save is withheld (said on the status line).
 │            saveMiss — in the slot: resolveOutputs(outputs) +
 │              resolveWorkspaceOutputs → file lists, and the
 │              project's git snapshot notes the written output paths
 │              so a same-project downstream task doesn't re-spawn git
 │              unless its globs overlap. Deferred onto the run's save
 │              lane (2×concurrency wide): cache.save(...) — pack
 │              <hash>.tar.zst with stdout + outputs/<rel>
 │              (+ workspace-outputs/<rel-to-root>), upsert entries +
 │              output_files + entry_inputs rows in one transaction.
 │              The slot frees at once; dependents wait on the save's
 │              `landed` promise (the scheduler's settledOf). Under a
 │              LayeredCache with remote writes on, the remote upload
 │              fires in the BACKGROUND (drained at end of run).
 │       9. Return TaskOutcome { node, status, exitCode, durationMs,
 │            hash, cpuMs?, peakRssBytes?, restored?,
 │            wallclockStartNs, wallclockEndNs }.
 │
 └─ End-of-run
    1. SIGTERM dependency-only persistent children; persistent tasks
       the user REQUESTED, those a requested group stands for (through
       nested groups, not through a one-shot), and the persistent tasks
       they depend on, are kept alive (see below).
    2. Run summary footer (projects / tasks / cache meters + info +
       time + result) — counts only real tasks (with `exec`); group tasks
       don't pollute the totals; failure frames replay just above it.
    3. Optional --summarize JSON (default <cacheDir>/runs/<run_id>.json)
       and --profile Chrome-trace JSON (default profile.json).
    4. recordRunBundle — one transaction writing a `runs` row per real
       task plus the `invocations` header row (command, git/CI/host
       context, tags, counts). Group + aborted tasks skipped; a run
       a signal stopped records nothing.
    5. Telemetry: emit the RunSummaryRecord to every active sink +
       await their flush (crash-isolated; skipped when no sink).
    6. Drain background remote prefetches/uploads; cache.close();
       sandbox teardown when any task was sandboxed.
    7. Return { ok, outcomes }; ok = every task ended success or a
       cache hit (any failed/skipped/aborted → ok = false → exit 1),
       and no persistent child exited on its own before the run
       stopped it.
    8. FOREGROUND ONLY: if the user requested persistent tasks (dev
       servers) and nothing else failed (or under `--continue=always`),
       the process now blocks until ONE of them, or a persistent task they
       depend on, exits — the
       summary is already printed, `▸ <id> running` rows list what's
       alive, Ctrl-C reaps the process group. That first exit ends the
       session: the others are torn down (SIGTERM, grace, SIGKILL) and
       a non-zero exit makes the run exit 1, so a script's `vx run dev`
       fails when the server it started fell over. That server then reads
       `failed` with its own exit in the rewritten `--summarize` and in the
       outcomes `--report` renders; one a Ctrl-C stopped does not. Under
       `holdPersistent` (the watch loop) run() instead returns them on
       `RunSummary.persistent`, still running, for the caller to stop;
       one that dies on its own after that is said, its `stop()` is not.
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

A task is over when its command's own process exits. What a descendant
writes after that — one the command detached with `setsid … &`, or
daemonized — is not the task's output: the save has already run, and a
later hit's restore removes it ([caching](./caching.md#cache-write)).
`wait` for what the command backgrounds.

## Env isolation

The child process gets, in priority order (lowest first):

1. **Essential allowlist** (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`,
   `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`,
   `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS` — the list is
   `ESSENTIAL_ENV` in `src/exec/env.ts`).
2. **`exec.env.passThrough`** names → values from host `process.env`.
3. **`exec.env.define`** literal name/value pairs.
4. **PATH augmentation** — `<projectDir>/node_modules/.bin`, then
   `<workspaceRoot>/node_modules/.bin`, are prepended so installed
   tools (`oxlint`, `vite`, etc.) work without `npx`. Never a sibling
   project's bin; those stay invisible. A bin directory whose path holds
   PATH's delimiter (`:`) is left out: PATH cannot name it, and split it
   became two entries, one relative to the task's cwd. A task whose shell exits 127 or 126 gets one more frame line
   (`orchestrator/shell-verdict.ts`): for a bare word, that 127 is the
   shell's "command not found", the word (when the command is a plain
   `word args…`), the two bin directories vx puts first, and that a
   sibling project's bin is never visible (or, when a bin directory was
   left out for its `:`, that directory and the fix: move the
   workspace), and on 126 `chmod +x`; for
   a word with a slash, what the file says — missing (the resolved
   path), a directory, not executable by this user, a `#!` interpreter that does
   not exist (a CRLF line ending is named as such), or no `#!` line.
   An exit above 128 gets the same line for its signal: which one, and
   what sends it (the OOM killer, a crash in native code, an abort, a
   reader that left a pipe, a ulimit, a seccomp refusal); vx's own
   timeout and a shutdown's SIGTERM keep their own lines.

Anything not in these four layers is invisible to the child, except
the two vx sets itself — `VX_RUN_WORKSPACE` and `VX_RUN_TASK` — so a
task that shells out to `vx run` in its own workspace is refused
before it forks without bound, and `npm_execpath`, the workspace's
package manager (unkeyed; `schema.md` § `env`). A sandboxed task also gets the sandbox's own
proxy, CA and `TMPDIR` values
([`modules/sandbox-runtime.md`](./modules/sandbox-runtime.md#the-environment-srt-sets)). This prevents incidental env leakage
between machines and gives reproducible runs.

The allowlist + isolation contract lives in
[`modules/env.md`](./modules/env.md) and is the only field the
contract assumes for "what every command needs to function" on
Linux and macOS (Windows is WSL, which is Linux). Adding to the allowlist would be a deliberate
schema-extending change (consumer code expects a particular set;
broader access has cache-stability implications).

## Failure handling

| Failure                                                                                                                                                          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exec exits non-zero                                                                                                                                              | Task is `failed`; cache NOT written; output streamed live + the failure frame replays at run end                                                                                                                                                                                                                                                                                                                                                          |
| `exec.timeout` overrun                                                                                                                                           | SIGTERM to the task's group, SIGKILL for whoever is left after the grace; task is `failed` (timed out), exit 143 (137 when the SIGKILL took it, and the line says so), never cached                                                                                                                                                                                                                                                                       |
| Child killed by Ctrl-C teardown (SIGINT/SIGTERM/SIGHUP), or by an embedder's `RunOptions.signal` abort — which also completes every never-started task `aborted` | Task is `aborted` — not counted, not recorded. An attempt that ends while the run is stopping is `aborted` whatever its exit: a trap that exits 0 is not cached, and a failure is not retried (item 962). What it printed still shows in its frame. A child killed by a signal while the run is NOT stopping (a supervisor's SIGTERM, a `kill` from another shell) is `failed (exit 143, 128 + SIGTERM)`: retried, shown, and fail-fast trips (item 1100) |
| `execute()` throws (internal error)                                                                                                                              | Task marked `failed`; stderr written `[vx] internal error in <id>` (a `UserError` reports plainly); a plugin executor's throw reports plainly as `plugin '<p>' (executor '<e>') failed in execute: <reason>` (C-63, C-85)                                                                                                                                                                                                                                 |
| Persistent task exits before ready                                                                                                                               | Task marked `failed` with `exited before becoming ready (exit N)`; its output already streamed live; `aborted` when the run's stop killed it (C-62)                                                                                                                                                                                                                                                                                                       |
| Upstream task fails                                                                                                                                              | Dependents marked `skipped` (exit 1, durationMs 0); no command runs — EXCEPT a restore-tier task, whose confirmed cache hit still restores (its key is dep-independent)                                                                                                                                                                                                                                                                                   |
| Sandbox violation (macOS monitor / Linux structural)                                                                                                             | Task is `failed`; violations render in the frame; nothing cached                                                                                                                                                                                                                                                                                                                                                                                          |
| Remote-cache error (500, timeout, corrupt artifact)                                                                                                              | Degrades to a cache miss; never fails the run                                                                                                                                                                                                                                                                                                                                                                                                             |
| No pnpm-workspace.yaml or package.json in cwd or any parent                                                                                                      | `findWorkspaceRoot` throws (UserError); `vx run` exits 1                                                                                                                                                                                                                                                                                                                                                                                                  |
| Same-project task referenced in `dependsOn` not declared                                                                                                         | `buildTaskGraph` throws with the offending edge                                                                                                                                                                                                                                                                                                                                                                                                           |
| Duplicate workspace package name                                                                                                                                 | `listProjects` throws with both paths                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cycle in task graph                                                                                                                                              | `detectCycle` throws with the cycle path                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Malformed config                                                                                                                                                 | `loadProjectConfigs` throws (UserError) with file + field                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cache.inputs.runtime` command exits non-zero                                                                                                                    | UserError naming the command + exit code; that task is `failed`, dependents skip                                                                                                                                                                                                                                                                                                                                                                          |

Failures don't kill the scheduler — independent tasks already in
flight finish, and unrelated tasks not yet started still run. The
overall exit code is 1 if any task ended in `failed`, `skipped` or
`aborted` status, or a persistent child exited before the run stopped
it.

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
  skipped, plus `▸` for a pinned persistent row; a live worker row has
  no glyph — its ticking elapsed time leads instead); glyph COLOR + the
  status word = task axis
  (success / failed / skipped / running); the cache word (miss /
  fresh / local / remote) spells it out.
- **Buffered, framed (non-focused paths).** `runCommand` listens to
  the child's stdout/stderr and calls `onStdout` / `onStderr` per
  chunk. Outside focused streaming, the default logger buffers the
  chunks per-task and dumps the full body as a framed block on task
  completion. No per-line prefix, no interleaving between concurrent
  tasks.
- **Cache write.** The captured stdout — its first and last 8 MiB,
  the cut middle named — is stored in the entry; replay is stdout-only.
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

There is no special handling for binary output. Stdin is never the
terminal unless the task declares `exec.interactive` and vx's stdin is
a TTY (schema.md § `interactive`): then the task gets vx's stdin,
stdout and stderr, runs alone, and nothing of it passes through vx.
Otherwise the rule splits on `exec.persistent`:

- **A one-shot task** gets `'ignore'`: it sees EOF at once, so a task
  that reads stdin finishes instead of hanging CI
  (`tests/runner.test.ts` › "a task that reads stdin sees EOF at once,
  never a hang"). A task that needs TTY input declares
  `exec.interactive`.
- **A persistent task** gets a pipe vx holds and never writes: it stays
  open while vx lives and ends when vx does. A dev server that exits on
  stdin EOF — esbuild `--watch`, the Vite case in turborepo#8915 —
  became ready and exited 0 under `'ignore'`, and `vx run dev` ended
  green (fixed 2026-09-24, `tests/keep-alive.test.ts` › "a server that
  exits on stdin EOF stays up while vx runs"). Each task has its own
  pipe, so several persistent tasks never compete for keystrokes; none
  receives any, so a server's keyboard shortcuts (Vite's `h`, `r`) do
  not reach it unless it declares `exec.interactive`. Not the terminal, because
  several servers would steal each other's input, and a CI's
  `/dev/null` stdin is the same EOF. Turbo's stream mode draws the same
  line: its pin is named `nonpersistent_task_sees_eof_on_stdin`.

A one-shot task ends when its shell exits, not when its pipes close. A
process the task left running (`server & echo up`) keeps stdout and
stderr open, so vx reads on for 250 ms after the shell exits and then
stops. That bound is what keeps a leftover server from hanging the run.
What the leftover writes after it is not captured — not in the frame,
not in the cache entry — and the frame says so with one line on stderr:
`[vx] output after the task's shell exited was cut: a process it left
running still held its stdout/stderr 250 ms later`. Until 2026-09-24 the
cut was silent (nx#35302 reproduced on vx; `tests/runner.test.ts` ›
"output a backgrounded child writes after the drain bound is cut, and
the frame says so"). A task whose output matters waits for what it
starts (`wait`).

Every surface uses one outcome vocabulary: task axis `success` /
`failed` / `skipped` / `aborted` (+ `running` live), cache axis
`miss` / `up-to-date` (fresh) / `local` / `remote`. The `--verbosity 1`
table spells the combinations out as `success` / `restored-local` /
`restored-remote` / `up-to-date`; `--report` keeps the two axes as its
Status and Cache columns.

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
  projects/tasks/cache meters, info, time and result rows).

## Concurrency

- **Default** — the cores this process may use: `navigator.hardwareConcurrency`
  capped by the cgroup CPU quota a container runs under (`cpu.max` on v2,
  `cpu.cfs_quota_us` on v1, an ancestor's quota binding too; a 1.5-core
  quota is two workers, never below one — `util/cgroup.ts`), or
  `vx.workspace.ts`'s `concurrency` field when set. Inside a container the
  raw count is the HOST's, and eight workers on a two-core quota is
  oversubscription by four; `--concurrency <n>%` is a percentage of the
  same capped count.
- **Override** — `--concurrency N` (CLI). CLI wins over workspace
  config.
- **`concurrency: 1`** serializes everything while still respecting
  topo order: execs and restores share the one slot.
- The scheduler never exceeds the cap; tasks queue. Above 1,
  restore-tier tasks run on their own lane, `2 × concurrency` wide,
  and never take an exec slot.
- Failure of a task doesn't pause the scheduler — independent
  siblings continue running and starting.

### Executor pools

`concurrency` counts LOCAL worker slots. An executor that runs its tasks
somewhere else declares its own `capacity`, and the tasks placed on it are
admitted against that number instead — so a 64-wide worker pool is not
throttled by a 10-core laptop, and a `--concurrency 1` run still keeps the
pool full. A `capacity` that is not a positive integer is refused:
`plugin '<p>' returned executor '<e>' with capacity <v>: it must be a
positive integer`.

- **Placement is decided once per task, before scheduling.** `run()` asks
  the declared executors, in order, which one takes each task (see
  [`schema.md` § `remote`](./schema.md#remote-optional) for what pins a
  task here); the scheduler then knows which pool every task will occupy.
- **A pooled task holds nothing on this machine.** The `admit` stage is
  asked only for tasks about to run here, with the tasks running here; a
  task on an executor pool is never asked and never counted, so it can
  never park behind a local reservation.
- **Restore-tier tasks always use the restore lane**, even when placed
  on an executor with a `capacity`: a restore is local disk work.
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
Combining either with `--summarize`, `--profile`, `--report` or
`--report-file` is a parse error (those need a real run; the last two
were accepted and wrote nothing until item 992).

## Run artifacts

- **`--summarize[=<path>]`** — per-run JSON to
  `<cacheDir>/runs/<run_id>.json` by default (or the explicit path).
  Mirrors the `runs` table shape — one task entry per real task, hits
  included, with status, hash, duration, cpu_ms, peak RSS, hrtime spans
  (bigint serialized as strings to preserve ns precision).
- **`--profile[=<path>]`** — Chrome-trace JSON of every task's
  wallclock span. Default path: `profile.json` (cwd-relative). One
  `tid` per project so concurrent tasks render on distinct lanes.
  Open with `chrome://tracing` or https://ui.perfetto.dev.
- **`--report[=markdown]`** — a markdown table to stdout
  after the run (CI step summaries).

Writers live in `orchestrator/run-artifacts.ts:writeRunSummary` /
`writeRunProfile` and `orchestrator/run-report.ts`. A `--summarize` or
`--profile` write error is surfaced via `log.status`, a `--report-file`
one on stderr (`cli/run.ts`); neither changes the run's exit code — the
run already happened.

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
- **Misses own the worker pool.** A miss is the critical path, so
  the exec lane is `concurrency` wide and only executions take it.
  Restores run on their own lane, so warm work never queues behind
  ordering it doesn't need and never takes a slot from real work.
- **Forwarded args don't reach upstream tasks.** Otherwise
  `vx run build -- --watch` would set `--watch` on every upstream's
  build, and upstream cache keys would partition by CLI args that
  don't change their behavior.
- **`recordRunBundle` skips group tasks.** They aren't real runs;
  analytics queries that sum duration would double-count without it.
- **A requested persistent task keeps the run alive.** The dev server
  IS the point of the run; tearing it down the instant it became
  ready would make `vx run dev` useless.
