# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/plugins/local-executor/` (see plugins.md).

## Public surface

- `TaskExecutor { name; remote?; capacity?; accepts?(task); execute(req) }`
  — `remote: true` declares that the executor runs the command somewhere
  else (so it is never offered a `pinnedLocal` task); `capacity` is how
  many tasks it runs at once, which makes its tasks a POOL of that size
  instead of local worker slots.
- `TaskPlacement { taskId; projectName; projectDir; command; pinnedLocal;
cacheable }` — what `accepts()` sees. Placement happens ONCE per task,
  before scheduling, so it cannot depend on anything resolved per attempt.
- `ExecuteRequest` — `taskId`, `workspaceRoot`, `command`, `forwardArgs`,
  `cwd`, `env`, `capture`, `outputs`, `timeoutMs?`, `onStdout`, `onStderr`,
  `liveChildren?`, `sandbox?: ExecuteSandbox`, `inputs?: TaskInputs`.
  `outputs` is the DECLARED output globs (`files` project-relative,
  `workspaceFiles` root-relative) — what an executor running elsewhere has
  to bring back.
- `TaskInputs` — everything the cache key folds, WITH values: `files`
  (workspace-relative path + git-blob digest of the worktree bytes, own
  outputs excluded), `env` (declared names + resolved values), `runtime` /
  `workspaceRuntime` (command + the output that was folded — a toolchain
  expectation a worker must reproduce), `upstream` (dependency task ids +
  cache keys + each one's declared `outputs`, workspace-relative — already
  restored on disk before this task runs, so an input-shipping executor can
  put them in the input root; empty when that dependency has no local cache
  entry), `packageJsonDigest`, `configDigest`, `workspaceFingerprint`.
  Present on the miss path of a cacheable task only; a task with no
  `cache` ships nothing. Built by `task-hash.describeTaskInputs` from the
  SAME resolution that produced the key, so it cannot drift from what a
  hit would have matched; held in memory for the attempt and never
  persisted (`env`/`runtime` values may be secrets — `entry_inputs` stores
  digests only).
- `ExecuteResult extends RunResult { violations }`
- `selectExecutor(executors, task)` — first executor, in order, that may
  take the task: a `remote` executor is skipped outright for a
  `pinnedLocal` task, then `accepts` decides. Throws naming the task when
  all decline (the message says to declare `localExecutorPlugin()` after
  the one that declined).

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor — they
  are local by construction and stay on `runPersistent`.
- A task is `pinnedLocal` when it is persistent, transitively depends on a
  persistent task (a worker cannot reach a port on the submitter), or
  declares `exec.remote: false`. `run.ts` computes the set once per run.
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and each task is PLACED once, before scheduling — every attempt of a task,
  including retries, runs on the executor it was placed on. Placement must
  precede scheduling because the scheduler admits a pooled task against its
  executor's `capacity` rather than a local worker slot.
- `exec.remote` is stripped from the cache key (`task-hash.hashableConfig`),
  the same as `exec.resources`: placement has no effect on outputs, and a key
  that moved with it would gut the remote hit rate.

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
