# `src/orchestrator/execute-task.ts` — per-task runtime

## Purpose

The seam between the scheduler and the cache + runner. Given one
`TaskNode` and its upstream outcomes, decide what to do (group
short-circuit, persistent spawn, or normal cache-or-exec flow) and
return a `TaskOutcome` to the scheduler.

## Public surface

```ts
export interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  noCache: boolean
  forwardArgs?: readonly string[]
  log: Logger
  nestedProjectDirs: string[]
  runStartHrTimeNs: bigint
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  liveChildren?: Set<ReturnType<typeof Bun.spawn>> // run-scoped; signal handler SIGTERMs these
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  forwardArgs?: readonly string[]
  nestedProjectDirs: string[]
}

export function executeTask(args: ExecuteArgs): Promise<TaskOutcome>

/** Cache-key derivation. Used by executeTask AND plan() for --dry. */
export function computeTaskHash(args: ComputeHashArgs): Promise<string>

/** Hash a group task's upstream so downstream still invalidates on changes. */
export function computeGroupHash(upstream: TaskOutcome[]): string
```

## Three execution paths

### A. Group task (no `exec`)

Return `{ status: 'success', exitCode: 0, durationMs: 0, hash: computeGroupHash(upstream) }`.
No spawn, no I/O. The hash is a stable rollup so downstream tasks
filtering `inputs.tasks` to include this group still invalidate when
anything beneath it changes.

### B. Persistent task (`exec.persistent` set)

1. Build isolated env (same as normal — see [`env.md`](./env.md)).
2. Construct `PersistentOptions` for `runPersistent`. The
   `forwardArgs` are appended in-line when `readyWhen` is undefined
   AND `forwardArgs.length > 0` (otherwise the regex matching is on
   the unmodified command).
3. Call `runPersistent(opts)`. Stash the returned `child` in
   `persistentRegistry[node.id]`.
4. `await spawn.ready`. On reject (child exited before ready) →
   return `failed` with the captured streams.
5. On resolve → return `success` with `durationMs = spawn.readyMs()`.

The orchestrator SIGTERMs every registry entry at end-of-run. Never
caches.

### C. Normal task

1. `computeTaskHash(...)` — see below.
2. `cleanArgs = { projectDir, outputs, nestedProjectDirs }` is
   prepared once.
3. **If caching is on**: `cache.get(hash)`.
   - Hit: `cleanOutputs(cleanArgs)` (only when `outputs.length > 0`) →
     `cache.restoreOutputs(hash, projectDir)` → replay `hit.stdout` /
     `hit.stderr` via `log.taskStdout` / `log.taskStderr`. Return a
     `cache-hit` (or `cache-hit-remote` if `hit.source === 'remote'`)
     outcome with `durationMs = performance.now() - cacheOpStart` —
     the user-perceived restore time.
4. Miss-or-no-cache:
   - If caching enabled, `cleanOutputs(cleanArgs)` first so a stale
     `dist/` doesn't survive into a fresh exec.
   - Build isolated env (`<projectDir>/node_modules/.bin` PATH
     prepend).
   - `wallclockStartNs = process.hrtime.bigint() - runStartHrTimeNs`.
   - `runCommand({...})` — Bun.spawn shell. Forward args quoted.
   - `wallclockEndNs = process.hrtime.bigint() - runStartHrTimeNs`.
5. **If exit 0 + caching enabled**: `resolveOutputs(...)` →
   `cache.save({ hash, projectDir, outputFiles, entry })`.
6. Return outcome with hash, status (`success` / `failed`),
   exitCode, durationMs, captured stdout/stderr, hrtime spans, and
   (when Bun's resourceUsage returned them) `cpuMs` / `peakRssBytes`.

## Hash derivation (`computeTaskHash`)

The pieces folded into `cache.key(...)`:

| Field                    | Source                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `taskId`                 | `node.id`                                                               |
| `taskConfigHash`         | `sha256(JSON.stringify(node.config))` (internal `hashTaskConfig`)       |
| `projectPackageJsonHash` | `sha256(<projectDir>/package.json)` (internal `hashProjectPackageJson`) |
| `envValues`              | `resolveInputs` reads host env for declared `inputs.env` names          |
| `inputFiles`             | `resolveInputs` glob result (gitignore + boundary-filtered, sorted)     |
| `upstreamHashes`         | `filterUpstreamHashes(upstream, cacheCfg?.inputs?.tasks, ...)`          |
| `workspaceFingerprint`   | passed in                                                               |
| `forwardArgs`            | `node.requested ? (args.forwardArgs ?? []) : []`                        |

`forwardArgs` are scoped to user-requested tasks. The reason it's
folded into the key for those tasks: `vx run test -- --watch` should
not cache-hit a previous `vx run test`. The reason it's NOT folded
in for dep-pulled tasks: their cache identity is supposed to be
stable across CLI args.

## What this does NOT do

- Doesn't handle the run-level setup (workspace discovery, graph
  build, cache opening) — `orchestrator.ts` does.
- Doesn't drive the live console output — `log: Logger` does. This
  module just calls `log.taskStdout` / `log.taskStderr`.
- Doesn't record the analytics row — `orchestrator.ts` does after
  the run drains.
- Doesn't enforce `cache + persistent`-rejection — the project
  loader does at config-load time.

## Tests

Covered indirectly by `tests/orchestrator.test.ts`. Specific
behaviors with dedicated test cases:

- Group-task hash rollup (`tests/orchestrator.test.ts` — cascading
  invalidation through groups).
- Persistent task ready-then-success outcome shape.
- Cache-hit replay restores outputs AND replays log streams.
- Cache miss followed by cache write; subsequent hit returns from
  local.
- Forward-args isolation (dep-pulled task's hash doesn't drift).

## Replacing this module

This module is the seam most likely to grow over time. Plausible
extensions:

- **fspy-style input tracing.** Replace the static `resolveInputs`
  call with a wrapped runner that records reads during exec, then
  use the observed set as the cache input on the next run.
- **Conditional output capture.** Compress / dedupe before save.
  Hook between `resolveOutputs` and `cache.save`.
- **Pre-spawn hooks.** Run a setup script (e.g. cgroup/limits
  application) before each `runCommand`. Add to `ExecuteArgs`.
- **Different cache layer.** Already abstracted via `CacheLayer` —
  the caller decides which.
