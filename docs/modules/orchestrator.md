# `src/orchestrator/{index,run}.ts` — end-to-end glue

## Purpose

The orchestrator module's entry. `run.ts` hosts `run()` / `planRun()`;
`index.ts` is the module contract re-exporting them with
`RunOptions` / `RunSummary` ([`options.md`](./options.md)), `Logger` /
`defaultLogger` ([`logger.md`](./logger.md)), and the `RunPlan` types
([`plan.md`](./plan.md)). Invoked by `cli/run.ts`. Discovers the
workspace, loads configs, builds the task graph, opens the cache,
schedules execution, manages persistent subprocesses, writes optional
artifacts, and records the run history.

Companion module: [`plan.md`](./plan.md) for the read-only
`--dry` / `--graph` mirror.

## Public surface

```ts
export interface RunOptions {
  cwd: string
  tasks: readonly string[] // mixed bare + `pkg#task` positionals
  projects?: string[] // pre-resolved scope (from cli/run.ts)
  concurrency?: number
  cache?: CachePolicy // 4-axis read/write control; undefined → everything on
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  outputLogs?: 'full' | 'errors-only' | 'none' // explicit output override
  flow?: 'focused' | 'broad' // CLI-detected run intent (see logger.md)
  summarize?: string // path or '' for default
  profile?: string // path or '' for default
  log?: Logger
  handleSignals?: boolean // default true; watch mode passes false
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}

export function run(options: RunOptions): Promise<RunSummary>
export function planRun(options: RunOptions): Promise<RunPlan>

// via index.ts (the module contract):
export { defaultLogger, resolveOutputView } from './logger.js'
export type { Logger, OutputView } from './logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './plan.js'
```

## Algorithm — `run()`

1. **Color decision.** Programmatic logger → plain text. Default
   logger → `detectColors()` (NO_COLOR / FORCE_COLOR / isTTY).
2. **`prepareRun(options, log)`** (`orchestrator/prepare.ts`) runs the
   shared setup: `findWorkspaceRoot`, `loadWorkspace`,
   `loadWorkspaceConfig`, `listProjects`, per-project
   `loadProjectConfig`, `buildPackageGraph`,
   `computeNestedProjectDirs`, `expandRequested`, `buildTaskGraph`,
   `computeWorkspaceFingerprint`, and `new Cache(...) +
wrapWithRemoteCache`. Returns a `PreparedRun` with the cache
   handle; **caller owns `cache.close()`**.
3. **Empty-case handling.** If `prepared.empty !== null`, log the
   appropriate message (`no-tasks-declared` or `empty-graph`), close
   the cache, return NOT-ok.
4. **Concurrency** = `options.concurrency ?? workspaceConfig.concurrency
?? navigator.hardwareConcurrency`.
5. **Run-level state.** `runId` (ULID) + `runStartHrTimeNs` anchor +
   `liveChildren` set + `persistentRegistry` map. Stays in `run()` —
   not shared with `planRun()`.
6. **Signal handlers.** SIGINT/SIGTERM handlers are installed here
   and removed in a `finally` (see "Signal shutdown" below).
7. **Header.** Packages-in-scope, task names, remote-cache enabled?
   Then `log.runStart?.({ total })` seeds the status line.
8. **`runGraph(...)`.** Scheduler executes each ready node via
   `executeTask`. Starts call `log.taskStart?.`; each finished
   outcome gets `log.taskComplete`.
9. **Persistent cleanup.** Every entry in `persistentRegistry` is
   SIGTERMed; `Promise.allSettled` waits for exits before continuing.
   Then `log.runEnd?.()` clears the status line (also called from the
   `finally` so a thrown cycle can't leave it behind).
10. **Summary.** `formatRunSummary(list, totalMs)` — the shared
    `tallyOutcomes` helper inside excludes group tasks.
11. **Optional artifacts.** `writeRunSummary` / `writeRunProfile` when
    `summarize` / `profile` options are set. Errors logged, exit code
    unchanged.
12. **`recordRun` per real task.** Group tasks skipped (via the
    shared `isGroupTask` predicate).
13. **`cache.close()`.**

`planRun()` mirrors steps 1–2 via the same `prepareRun`, then
delegates to `orchestrator/plan.ts:plan(...)` inside a try/finally
that closes the cache. No scheduler, no spawn, no SIGTERM, no
recordRun.

## Forwarded-args scoping

`RunOptions.forwardArgs` are appended to user-requested tasks only.
The `expandRequested` step tags the user's `(project, task)` pairs
with `requested: true` on each `TaskNode`. `executeTask` scopes
`forwardArgs` accordingly:

- A `TaskNode.requested === true` task sees the forwarded args
  appended to its `exec.command` AND folded into its cache key.
- A dep-pulled `TaskNode.requested === false` task ignores the args
  entirely.

This keeps `vx run build -- --watch` from leaking `--watch` into every
dep's build AND keeps upstream cache identity stable across CLI args.

## Persistent registry

`persistentRegistry: Map<taskId, Bun.spawn>` is owned here. Reasons:

- The scheduler doesn't know about long-running tasks; it sees them
  as instant successes that resolve at "ready".
- We need a single place to SIGTERM them all once the rest of the
  graph drains, regardless of overall success/failure.
- A registry keyed by `taskId` makes test assertions tractable.

## Signal shutdown

`run()` installs SIGINT + SIGTERM handlers for its own duration
(unless `RunOptions.handleSignals === false`) and removes them in a
`finally`, so repeated `run()` calls never stack listeners. On
signal:

1. SIGTERM every child in `liveChildren` (one-shot spawns; the
   runner adds/removes each child around its spawn) and every entry
   in `persistentRegistry`. `Subprocess.kill` is idempotent on
   already-exited children.
2. Close the cache handle (double-close vs the normal path is
   tolerated — we're exiting).
3. `process.exit(signalExitCode(signal))` — 130 for SIGINT, 143 for
   SIGTERM.

This covers programmatic signals (CI cancellation, `kill <pid>`)
that don't benefit from terminal process-group propagation. v1
doesn't cancel scheduling — the process exits immediately after
forwarding SIGTERM, so in-flight awaits never settle. Watch mode
passes `handleSignals: false` for its cycles: the loop owns signal
disposition for its whole lifetime (its `process.once` handlers
close watchers and resolve 0), and a cycle must never exit the
process out from under it.

## Failure semantics

The orchestrator does NOT throw on task failure — the scheduler
already converts thrown errors into `failed` outcomes. The `ok` field
on the returned summary is `false` iff any outcome was `failed` or
`skipped`. CLI maps this to exit code 1.

`findWorkspaceRoot` / `listProjects` / `loadProjectConfig` /
`buildTaskGraph` can throw (UserError or generic Error). The CLI
catches at `cli/run.ts:runCmd` and prints + exits 1.

## Tests

`tests/orchestrator.test.ts` — the heaviest test file in the repo.
End-to-end coverage of:

- Basic single-task / multi-task runs.
- Caching (hit, miss, restore, replay).
- Cross-project graphs via `^name` / `pkg#name`.
- Forwarded args (scope, cache-key folding).
- Failure handling (failed exit, thrown error, upstream-failure
  skipping).
- Persistent tasks (ready / fail-before-ready / SIGTERM teardown).
- Output cleaning (before exec, before restore).
- `--summarize` and `--profile` artifact writers.
- Project-boundary enforcement (a parent's glob can't reach a child).

## Replacing this module

The smallest extension surface in the codebase. To extend, you
typically replace something downstream and leave this module alone.
Cases where you'd touch `orchestrator/run.ts` itself:

- **Different scheduler.** Construct your own scheduler that consumes
  the same `runGraph` signature.
- **Different cache layering.** Replace `wrapWithRemoteCache` with a
  three-layer (regional + central) wrapper.
- **Telemetry sink.** Wrap `log` to also push to OTLP / your tracing
  backend. The header / summary / per-task callbacks are already
  hooked.
- **Different run-id stamp.** Replace `ulid()` (`src/util/ulid.ts`).
