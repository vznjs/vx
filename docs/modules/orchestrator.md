# `src/orchestrator.ts` — end-to-end glue

## Purpose

The top-level entry point invoked by `cli/run.ts`. Discovers the
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
  noCache?: boolean
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  summarize?: string // path or '' for default
  profile?: string // path or '' for default
  log?: Logger
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}

export function run(options: RunOptions): Promise<RunSummary>
export function planRun(options: RunOptions): Promise<RunPlan>

export { taskId } from './graph/task-graph.js'
export type { Logger } from './orchestrator/logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './orchestrator/plan.js'
```

## Algorithm — `run()`

1. **Color decision.** Programmatic logger → plain text. Default
   logger → `detectColors()` (NO_COLOR / FORCE_COLOR / isTTY).
2. **Workspace setup.** `findWorkspaceRoot`, `loadWorkspace`,
   `loadWorkspaceConfig`, `listProjects`. Each project's
   `vx.config.*` is loaded; projects without configs are kept in the
   graph (for package-graph relations) but contribute no tasks.
3. **`buildPackageGraph` + `computeNestedProjectDirs`.** One pass each
   over the project list.
4. **`expandRequested(tasks, candidates, projects)`.** User tasks →
   concrete `(project, task)[]`. Bare names fan out across scope;
   anchored entries pass through. Empty result is treated as a CI
   footgun — we return `{ ok: false, outcomes: [] }`.
5. **`buildTaskGraph(...)`.** Builds the full DAG.
6. **Cache setup.** `new Cache(resolveCacheDir(root, workspaceConfig))`
   then optionally `wrapWithRemoteCache(local, log)`.
7. **Concurrency** = `options.concurrency ?? workspaceConfig.concurrency
?? navigator.hardwareConcurrency`.
8. **`computeWorkspaceFingerprint(root)`.** One sha256 reused per task.
9. **Run-level state.** `runId` (ULID) + `runStartHrTimeNs` anchor +
   `persistentRegistry` map.
10. **Header.** Packages-in-scope (the unique projects covered by the
    graph, including dep-pulled), task names, remote-cache enabled?
11. **`runGraph(...)`.** Scheduler executes each ready node via
    `executeTask`. Each finished outcome gets `log.taskComplete`.
12. **Persistent cleanup.** Every entry in `persistentRegistry` is
    SIGTERMed; `Promise.allSettled` waits for exits before continuing.
13. **Summary.** `formatRunSummary` over real tasks (those with
    `exec`), printed via `log.status`.
14. **Optional artifacts.** `writeRunSummary` / `writeRunProfile` when
    `summarize` / `profile` options are set. Errors logged, exit code
    unchanged.
15. **`recordRun` per real task.** Group tasks skipped.
16. **`cache.close()`.**

`planRun()` performs steps 1–9 then delegates to
`orchestrator/plan.ts:plan(...)`. No scheduler, no spawn, no SIGTERM,
no recordRun.

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
Cases where you'd touch `orchestrator.ts` itself:

- **Different scheduler.** Construct your own scheduler that consumes
  the same `runGraph` signature.
- **Different cache layering.** Replace `wrapWithRemoteCache` with a
  three-layer (regional + central) wrapper.
- **Telemetry sink.** Wrap `log` to also push to OTLP / your tracing
  backend. The header / summary / per-task callbacks are already
  hooked.
- **Different run-id stamp.** Replace `ulid()` (`src/util/ulid.ts`).
