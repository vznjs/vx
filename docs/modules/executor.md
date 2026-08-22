# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly.

## Public surface

- `TaskExecutor { name; accepts?(req); execute(req) }`
- `ExecuteRequest` — `taskId`, `command`, `forwardArgs`, `cwd`, `env`,
  `capture`, `timeoutMs?`, `onStdout`, `onStderr`, `liveChildren?`,
  `sandbox?: ExecuteSandbox`
- `ExecuteResult extends RunResult { violations }`
- `localExecutor()` — accepts every request.
- `selectExecutor(executors, req)` — first executor, in order, whose
  `accepts` is absent or returns true; throws naming the task when all
  decline (unreachable while `vx/local-executor` is in the list).

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor — they
  are local by construction and stay on `runPersistent`.
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and consulted per attempt, so a retry can land on a different executor
  only if `accepts` says so.

## What it does NOT do

- Ship inputs, materialise outputs elsewhere, or know about the cache —
  a remote executor is responsible for leaving the declared outputs under
  `cwd` when it returns (or a later design's `outputs` discriminator will
  say where they are; see `docs/design/plugin-executor-reapi-2026-08.md` §4).

## Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

## Replacing this module

Contribute `executor(ctx)` from a plugin; to wrap the local behaviour,
delegate to `localExecutor()` inside your own executor.
