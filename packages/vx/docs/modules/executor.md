# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/exec/local-executor.ts` and is appended to the TAIL of every executor list (`resolveExecutors`, plugin-host.ts), so a task every plugin declines runs here.

## Public surface

- `TaskExecutor { name; remote?; capacity?; accepts?(task); demand?(remaining); execute(req) }`
  — `remote: true` declares that the executor runs the command somewhere
  else (so it is never offered a `pinnedLocal` task); `capacity` is how
  many tasks it runs at once (a positive integer, else the run is
  refused), which makes its tasks a POOL of that size instead of local
  worker slots.
- `TaskPlacement { taskId; projectName; projectDir; command; pinnedLocal;
cacheable }` — what `accepts()` sees. Placement happens ONCE per task,
  before scheduling, so it cannot depend on anything resolved per attempt.
- `InputFile { path; digest }` — one entry of `TaskInputs.files`: the
  workspace-relative POSIX path and the git blob OID of the WORKTREE
  bytes (for a symlink, of its target string) — the same digest the key
  folds, so an executor elsewhere reproduces what a hit would match.
- `localExecutor()` — the floor at the tail of every executor list.
  Runs the command on this machine; what a plugin declining a task
  hands it back to. A request whose `signal` is already aborted (a stop
  that landed during the output clean) spawns nothing and returns the
  signal's exit: the command ran after the teardown had swept the run's
  children, and a Ctrl-C took 7.6 s (B-55). A sandboxed request asks
  again after its own awaits (the runtime, the tracer probe, the wrap),
  just before the spawn: a stop landing there ran the task (B-72). Internal (`src/exec/local-executor.ts`), not on
  `@vzn/vx`.
- `isLocalExecutor(executor)` — whether it is core's own, by identity (a
  plugin may name its executor 'local'): core bounds a plugin's
  `execute` after the request's abort, never the local one's (H-14).
- `ExecuteRequest` — `taskId`, `workspaceRoot`, `command`, `forwardArgs`,
  `cwd`, `env`, `envDefine` (`exec.env.define` verbatim: the host-free
  part of `env`, safe to ship), `capture`, `outputs`, `timeoutMs?`,
  `onStdout`, `onStderr`, `signal?` (aborted when the run stops or
  `timeoutMs` elapses: an executor ends its work and returns, since core
  cannot reach a process it spawned; a non-zero exit after the timeout's
  abort is recorded `timedOut`; one that has not returned within the
  kill grace of the abort is abandoned, the attempt settled without it),
  `liveChildren?`, `sandbox?: ExecuteSandbox`,
  `inputs?: TaskInputs`, `cacheKey?` (a cacheable task's key, the address
  an executor's own remote record uses), `refresh?` (cache reads are off:
  do not answer from that record), `remoteOnly?` (`exec.remote: 'only'`:
  leave outputs off this disk), `download?: 'eager' | 'deferred'`.
  `outputs` is the DECLARED output globs (`files` project-relative,
  `workspaceFiles` root-relative) — what an executor running elsewhere has
  to bring back.
- `ExecuteSandbox` — `baseAllowRead`, `baseDenyRead`,
  `reportWithin` (the project: denials there are reported), `reportLinked`
  (the canonical directories of the linked workspace packages core
  withheld from a cached task because its key does not answer for them:
  denials there are reported too), `config`. An executor that ships the
  sandbox elsewhere receives the narrowed `baseAllowRead`; enforcing it
  is its own.
- `TaskInputs` — everything the cache key folds, WITH values: `files`
  (workspace-relative path + git-blob digest of the worktree bytes, or of
  a symlink's target string, own outputs excluded), `env` (declared names + resolved values, `undefined` for an unset name), `runtime` /
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
- `ExecuteResult extends RunResult { violations; outputs?; where? }` —
  `outputs` is `{ kind: 'disk' }` or `{ kind: 'deferred'; materialize }`
  (outputs left remote, fetched only if a local consumer needs them).
  `spawnFailed: true` says the command never started (its 127 is the
  executor's, so no "command not found" line follows; A-41).
  Checked at the
  seam (`assertExecuteResult`): a plugin that resolves something else is
  refused with one line naming the executor, the task and the field
  ("returned an invalid result for <task>: exitCode is undefined (expected
  a number) — a plugin bug, not a task failure"), in the task's frame,
  never a TypeError inside core. `where` is the
  executor-reported placement label (a REAPI worker id); absent = this
  host. Rides `TaskOutcome.where` into telemetry only (OTel:
  `vx.task.where`), never the analytics store.
- `selectExecutor(executors, task, label?)` — first executor, in order,
  that may take the task: a `remote` executor is skipped outright for a
  `pinnedLocal` task, then `accepts` decides. An `accepts` that throws
  is a `UserError` naming the executor as `label` does (the run passes
  `executorLabel`, which names its plugin too; item 1022). The local
  executor is the tail of the list and accepts everything, so the
  throw for "every executor declined" is unreachable from `run()`; it
  stays for a caller that builds its own list.
- An executor's `demand` is a hint: one that throws is warned once,
  naming the plugin, and that executor is asked no more that run (item
  1022).
- A plugin executor's `execute` that throws fails the task, its message
  prefixed `plugin '<p>' (executor '<e>') failed in execute:` in the
  frame and the scheduler's line; the error keeps its class, so a
  `UserError` still prints plainly and a plain `Error` as an internal
  one (C-63). The local executor's own throw is vx's and is not renamed.

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor — they
  are local by construction and stay on `runPersistent`.
- A task is `pinnedLocal` when it is persistent, transitively depends on a
  persistent task (a worker cannot reach a port on the submitter), is
  sandboxed (the sandbox is this machine's machinery), depends on a
  sandboxed task, declares `exec.remote: false`, or folds a runtime
  probe (`cache.inputs.runtime` / `workspaceRuntime`) into its key: the
  probe is this machine's answer, and a worker's output under it is a
  stale hit (C-2). `placement.ts`
  computes the set once per run (`tests/placement.test.ts`).
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and each task is PLACED once, before scheduling — every attempt of a task,
  including retries, runs on the executor it was placed on. Placement must
  precede scheduling because the scheduler admits a pooled task against its
  executor's `capacity` rather than a local worker slot.
- `exec.remote` is stripped from the cache key (`task-hash.hashableConfig`):
  placement has no effect on outputs, and a key that moved with it would
  gut the remote hit rate.

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
  action.

## Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

## Replacing this module

Contribute `executor(ctx)` from a plugin. `localExecutor()` is not on
`@vzn/vx`; an executor that declines a task (`accepts` → false) hands it
to the local floor.
