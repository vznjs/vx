# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/plugins/local-executor/` (see plugins.md).

## Public surface

- `TaskExecutor { name; accepts?(req); execute(req) }`
- `ExecuteRequest` — `taskId`, `workspaceRoot`, `command`, `forwardArgs`,
  `cwd`, `env`, `capture`, `timeoutMs?`, `onStdout`, `onStderr`,
  `liveChildren?`, `sandbox?: ExecuteSandbox`, `inputs?: TaskInputs`
- `TaskInputs` — everything the cache key folds, WITH values: `files`
  (workspace-relative path + git-blob digest of the worktree bytes, own
  outputs excluded), `env` (declared names + resolved values), `runtime` /
  `workspaceRuntime` (command + the output that was folded — a toolchain
  expectation a worker must reproduce), `upstream` (dependency task ids +
  cache keys — their artifacts are reachable through the run's cache
  layer), `packageJsonDigest`, `configDigest`, `workspaceFingerprint`.
  Present on the miss path of a cacheable task only; a task with no
  `cache` ships nothing. Built by `task-hash.describeTaskInputs` from the
  SAME resolution that produced the key, so it cannot drift from what a
  hit would have matched; held in memory for the attempt and never
  persisted (`env`/`runtime` values may be secrets — `entry_inputs` stores
  digests only).
- `ExecuteResult extends RunResult { violations }`
- `selectExecutor(executors, req)` — first executor, in order, whose
  `accepts` is absent or returns true; throws naming the task when all
  decline (the message says to declare `localExecutorPlugin()` after the one that declined).

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor — they
  are local by construction and stay on `runPersistent`.
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and consulted per attempt, so a retry can land on a different executor
  only if `accepts` says so.

## What it does NOT do

- Ship inputs or materialise outputs elsewhere — `inputs` describes the
  set, the executor moves it. A remote executor is responsible for leaving
  the declared outputs under `cwd` when it returns (a later design's
  `outputs` discriminator will say where they are; see
  `docs/design/plugin-executor-reapi-2026-08.md` §4).
- List the AMBIENT files a worker also needs (`tsconfig.json`, `.npmrc`,
  root manifests, `node_modules`): the key treats them as environment, not
  input. Same-checkout agents get them from the checkout; an input-shipping
  executor needs them declared or provided by the worker image / an install
  action. `--verify=inputs` surfaces the gap per task.

## Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

## Replacing this module

Contribute `executor(ctx)` from a plugin; to wrap the local behaviour,
delegate to `localExecutor()` (`@vzn/vx/plugins/local-executor`) inside your own executor.
