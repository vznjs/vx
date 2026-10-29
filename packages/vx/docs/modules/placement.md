# `src/orchestrator/placement.ts` — where each task runs

## Purpose

The placement of a task graph over the resolved executors, and the
plan-mode view of it. Split from `run.ts` on 2026-09-10 (pure motion):
`run()` decides what to run and in what order; this module decides
where each task lands, and `--dry` asks it the same question without
running anything.

## Public surface

```ts
export function pinnedLocalSet(
  nodes: Map<string, TaskNode>,
  sandbox?: boolean,
  servers?: boolean,
  runtime?: boolean, // false for a `runtime` executor
  exclusive?: boolean, // an `exclusive` executor: nothing pins, servers included
): Set<string>
// the exec.interactive tasks when `tty`, else none; throws UserError when two would read the keys at once
export function terminalHolders(nodes: Map<string, TaskNode>, tty: boolean): Set<string>

export interface Placements {
  executors: Map<string, TaskExecutor> // every placed task → the executor that took it
  remoteOnlyNoop: Set<string> // `remote: 'only'` tasks no remote executor took
  remoteOnly: Set<string> // `remote: 'only'` tasks a remote executor took
  servers: Map<string, TaskNode[]> // task on a `servers` executor → the persistent tasks it starts there
  carried: Set<string> // persistent tasks every dependant carries: never started here
  otherPlatform: Map<string, readonly string[]> // placed here, `exec.platforms` leave this machine out → its platforms
  unroutable: Map<string, readonly string[]> // of those, ones a routing executor could not take → platforms on offer
}
export function placeTasks(
  nodes: Map<string, TaskNode>,
  executors: readonly TaskExecutor[],
): Placements
// `ids` whose executor is not `remote` — they write in place
export function locallyPlaced(placements: Placements, ids: Iterable<string>): Set<string>
// the run's word on `otherPlatform`: refuse (an unroutable task, or CI), warn and skip, or nothing
export function platformVerdict(
  placements: Placements,
  ci: boolean,
): { refuse: string } | { warn: string } | undefined

export async function planExecutorOf(
  prepared: PreparedRun,
  log: Logger,
  policy: 'all' | 'toplevel' | 'none', // the run's --cache-download policy
  ci: boolean, // a platform refusal throws in CI, as the run's does
): Promise<{
  executorOf?: (id: string) => string | undefined
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  otherPlatform?: ReadonlyMap<string, readonly string[]>
}>

export function hasPooledExecutor(executors: readonly TaskExecutor[]): boolean
export function poolOfPlacement(
  placements: Placements,
): (id: string) => { name: string; capacity: number } | undefined
export const UNPLACED_EXECUTOR: TaskExecutor

// core's local executor for a plugin that runs tasks itself; arms the sandbox outside a run
export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  close(): Promise<void>
}
export function localFloor(sandboxes?: readonly SandboxConfig[]): LocalFloor
```

## Rules

- **Pinned to this machine**: a task that transitively depends on a
  persistent one (a worker cannot reach a port on the submitter), unless
  its executor declares `servers` and the server is carriable (no
  `sandbox`, no `exec.remote: false`, not requested): then
  `Placements.servers` names the servers each such task starts where it
  runs, and `Placements.carried` the ones no task placed here needs, which
  are never spawned here; a
  sandboxed task and its dependants (the sandbox is this machine's
  machinery; a boundary "verified" where it is not enforced passes
  vacuously; an executor that declares `sandbox` enforces it where it
  runs and is offered them), `exec.remote: false`, or a task whose key folds a runtime
  probe (`inputs.runtime` / `workspaceRuntime`: this machine's
  answer, which a worker's own runtime may not match, unless the executor
  declares `runtime` and checks it there; its dependants stay free, C-2). Pinned tasks never reach a remote
  executor;
  `selectExecutor` is told so and a remote executor declines. A
  persistent task itself, like a group, is not placed at all — it runs
  on this machine outside the executor list. An `exec.interactive` task
  goes to core's local executor without asking a plugin: only it can
  hand over this terminal. Its dependants stay free. The pin flows up the
  dependant edges from the tasks that pin themselves, one walk on an
  explicit stack (a recursion per edge threw `RangeError` from
  `vx run --dry` on a 50,000-deep chain); a graph where nothing pins
  itself builds no edge index at all.
- Everything else asks the executors in declaration order
  (`selectExecutor`); the local floor takes what nothing claimed.
- `exec.remote: 'only'` with a remote executor that accepts it runs
  there and its outputs stay remote (`remoteOnly`); with no remote
  executor it is a **no-op** on this machine — never executed, outputs
  never cleaned or restored (`remoteOnlyNoop`) — and the run says so.
- A pooled executor (one with `capacity`) hands the scheduler its pool
  through `poolOfPlacement`, so it can run more tasks at once than the
  local worker count. Each executor is its own pool: the scheduler counts
  a pool by name, so a second executor with a taken name (one package
  declared twice) gets `<name>#2`, where the two shared one capacity.
- `UNPLACED_EXECUTOR` is the sentinel behind a task that reached an
  executor without being placed: an internal error, never a fallback.
- `planExecutorOf` resolves the executors for a plan and places the
  graph; a failing hook does not fail the plan (a plan never fails
  over a label) but is said on the status line in the plugin's name.

## Tests

`tests/placement.test.ts` (the pin rules, a 50,000-deep chain pinned
at its bottom, `placeTasks`' gates); `tests/plugin-capabilities.test.ts` (placement end to end: pins,
decline-and-fall-through, `'only'` taken / no-op / said, pools, `--dry`
labels and the failure notice); `tests/download-policy.test.ts` (the
download modes placement feeds); `tests/plan-predict.test.ts`.
