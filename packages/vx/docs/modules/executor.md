# `src/exec/executor.ts` — the per-task execution contract

## Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/exec/local-executor.ts` and is appended to the TAIL of every executor list (`resolveExecutors`, plugin-host.ts), so a task every plugin declines runs here.

## Public surface

- `TaskExecutor { name; remote?; sandbox?; capacity?; accepts?(task); demand?(remaining, missed); footer?(); machines?(); idealMs?(); profile?(); running?(id); execute(req) }`
  — `idealMs()` is the run's end had it placed its tasks perfectly, from
  the run's start, replayed from what each took (the run summary's
  `idealMs`, shown beside the real time)
  — `machines()` returns a `MachineReport` per machine it ran tasks on
  (`{ name; status; cores; memoryBytes; done; failed; onlineMs; busyMs;
cpuPeak; cpuAvg; memoryPeakBytes; memoryAvgBytes; utilization }`), asked
  once at the end for the run summary when a telemetry sink is on;
  `ExecuteResult.machine` (`{ cores; memoryBytes; cpuShare? }`) is the size of the
  machine `where` names, which the run history keeps, and the share of a
  core the task's threads got there (history divides its CPU by it)
  — `footer()` returns `[label, text]` rows the run's footer shows, live
  and at the end (a bad shape shows none; a throw from any of these
  reports leaves it out and is warned once per executor and method); `ExecuteResult.where`
  is shown on the task's row and frame after its id, as `<id>@<where>`; `running(id)`
  says where a task it was handed runs, for the live row, or `null` while
  it holds the task for a machine (no row; the tasks line counts it `scheduled`)
  — `remote: true` declares that the executor runs the command somewhere
  else (so it is never offered a `pinnedLocal` task); `sandbox: true`
  says a remote one enforces `req.sandbox` where it runs and returns the
  violations, so a sandboxed task and its dependants are not pinned for
  it (`@vzn/vx-dte`'s workers run them through `localFloor`, which also stops
  a request's children when its `signal` aborts and no run holds them);
  a cached task's `req.sandbox.keyed` lists the project directories its
  key answers for, so such an executor can build the request again on
  its own machine (`sandboxRequestFor`);
  `servers: true` says a remote one starts a task's persistent
  dependencies where it runs the task (`req.servers`, each a `ServerSpec
{ taskId; command; cwd; env; readyWhen?; timeoutMs?; sandbox? }`, in dependency
  order), so their dependants are not pinned for it; `localFloor` starts
  each once, a sandboxed one inside its `exec.sandbox` built there, shares it with every later task, and stops them on `close()`,
  and a server that never became ready, or crashed after it was, fails the task with why,
  and a stop of the request ends its wait on one; `runtime: true`
  says a remote one answers a task's `inputs.runtime` / `workspaceRuntime`
  probes where it runs the task (`answerRuntime`) and fails it when one
  answers otherwise than `req.inputs` says this machine did, so a task
  whose key folds a probe is not pinned for it; `platforms` (a non-empty
  list of `PLATFORMS`, else the run is refused) are the machines it runs
  tasks on: a task naming `exec.platforms` is offered only to it when one
  is shared, and to no other remote executor; `capacity` is how
  many tasks it runs at once (a positive integer, else the run is
  refused), which makes its tasks a POOL of that size instead of local
  worker slots. Each flag (`remote`, `sandbox`, `servers`, `runtime`,
  `exclusive`, `timeouts`) is `true`, `false` or absent, else the run is
  refused: core reads it as `=== true`.
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
- `executorFallback(reason)` / `isExecutorFallback(err)` — a remote
  executor's way to give a task back, and core's test for it (matched by
  name, so another copy of `@vzn/vx` is recognised); see below. Only the
  first is on `@vzn/vx`.
- Runner's `withForwardArgs(command, args)` — the line the local executor runs:
  the args after `--` shell-quoted, before a trailing comment, never on a
  heredoc's terminator. On `@vzn/vx` for an executor that runs
  `ExecuteRequest.command` itself: the example's own join lost the args to
  a trailing comment and split `'a b'` (X-112).
- `hostPlatform()` — this machine as `exec.platforms` names it,
  `${process.platform}-${process.arch}` (`linux-x64`). Placement reads it.
- `isLocalExecutor(executor)` — whether it is core's own, by identity (a
  plugin may name its executor 'local'): core bounds a plugin's
  `execute` after the request's abort, never the local one's (H-14).
- `ExecuteRequest` — `taskId`, `workspaceRoot`, `command`, `forwardArgs`,
  `cwd`, `env`, `envDefine` (`exec.env.define` verbatim: the host-free
  part of `env`, safe to ship), `capture`, `outputs`, `timeoutMs?`,
  `onStdout`, `onStderr`, `signal?` (aborted when the run stops or
  `timeoutMs` elapses: an executor ends its work and returns, since core
  cannot reach a process it spawned; any exit after the timeout's
  abort, a 0 included, is recorded `timedOut` and fails (X-125); one that has not returned within the
  kill grace of the abort is abandoned, the attempt settled without it),
  `liveChildren?`, `onSpawn?` (an executor that runs the command as a
  process on this machine calls it with the pid, so a telemetry sink can
  sample the tree's CPU and memory; absent when nothing samples),
  `sandbox?: ExecuteSandbox`, `terminal?: true` (the
  task holds vx's terminal, `exec.interactive` on a TTY: its stdio is
  vx's own and the callbacks hear nothing; placement hands such a task
  to core's local executor alone),
  `inputs?: TaskInputs`, `cacheKey?` (a cacheable task's key, the address
  an executor's own remote record uses), `refresh?` (cache reads are off:
  do not answer from that record), `unsaved?` (core saves no entry
  under the key: the policy writes no layer, or an upstream failed under
  `--continue=always`, ran unkeyed or is keyless; an executor that saves
  results for dependants keeps them off the key too), `remoteOnly?` (`exec.remote: 'only'`:
  leave outputs off this disk), `platform?` (one of the task's
  `exec.platforms` the executor's `platforms` lists: run it there; its key
  folds it), `download?: 'eager' | 'deferred'`.
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
  entry; read from the index up front for a plugin executor, never for
  the local floor), and `configDigest`.
  Present on the miss path of a cacheable task only; a task with no
  `cache` ships nothing. Built by `task-hash.describeTaskInputs` from the
  SAME resolution that produced the key, so it cannot drift from what a
  hit would have matched; held in memory for the attempt and never
  persisted (`env`/`runtime` values may be secrets — `entry_inputs` stores
  digests only).
- `ExecuteResult extends RunResult { violations; outputs?; changed?; where? }` —
  `outputs` is `{ kind: 'disk' }` or `{ kind: 'deferred'; materialize }`
  (outputs left remote, fetched only if a local consumer needs them).
  `spawnFailed: true` says the command never started (its 127 is the
  executor's, so no "command not found" line follows; A-41).
  `leftRunning: true` says a process the command left still held its
  output when vx stopped reading: core saves no entry for the task.
  `changed` lists the tracked files (workspace-relative) the command
  changed where an executor ran it elsewhere: one the key read withholds
  core's save under the key, with the line an input changed here gets.
  Checked at the
  seam (`assertExecuteResult`): a plugin that resolves something else is
  refused with one line naming the executor, the task and the field
  ("returned an invalid result for <task>: exitCode is undefined (expected
  a number) — a plugin bug, not a task failure"; an `exitCode` that is
  no non-negative integer, or a `durationMs` that is no non-negative
  finite number, the same, X-11), in the task's frame,
  never a TypeError inside core. `where` is the
  executor-reported placement label (a REAPI worker id); absent = this
  host. Rides `TaskOutcome.where` into telemetry only (OTel:
  `vx.task.where`), never the analytics store.
- `selectExecutor(executors, task, label?)` — first executor, in order,
  that may take the task: a `remote` executor is skipped outright for a
  `pinnedLocal` task, then `accepts` decides. An `accepts` that throws
  is a `UserError` naming the executor as `label` does (the run passes
  `executorLabel`, which names its plugin too; item 1022), and so is
  one that answers a Promise (`async accepts`), which read as a yes.
  The local
  executor is the tail of the list and accepts everything, so the
  throw for "every executor declined" is unreachable from `run()`; it
  stays for a caller that builds its own list.
- An executor's `demand` is first called once the cache has said which
  placed tasks it holds, and leaves those out: a warm run's restores
  are no one's demand (`plugin-capabilities.test.ts` › "a task the
  cache answers is never counted"). A left-out task that executes after
  all is counted again. Its second argument, `missed`, holds the left
  tasks whose keys that probe found in no store, each store answering
  for every key: they will run, so a plan sizes on them rather than a
  guess (`executor-demand.test.ts`). Behind a remote with a batch
  `hasMany`, that first call waits for its answer, however many hits
  the index keeps: a key the index lacks may still be held (main
  7391c93 asked 14 workers for 71 tasks, 17 of which ran, 2026-10-23).
  With no batch probe, the index's kept hits answer it.
- An executor's `demand` is a hint: one that throws, or an `async`
  one that rejects, is warned once, naming the plugin, and that
  executor is asked no more that run (item 1022;
  `placement-async-hints.test.ts`).
- A plugin executor's `execute` that throws fails the task, its message
  prefixed `plugin '<p>' (executor '<e>') failed in execute:` in the
  scheduler's one line, which lands in the task's frame (C-63), plainly, as a refusal: the
  plugin is named, so it is not vx's internal error (C-85). The local
  executor's own throw is vx's and is not renamed.
- `executorFallback(reason)` (on the façade) is how a `remote` executor
  gives a task back: its `execute` rejects with it, core says
  `[vx] <task>: <reason> — running it here` once and runs a fresh request
  (its own timeout) on the local executor. A task placed
  `remote: 'only'` fails naming `reason` instead, as does one an
  `exclusive` executor took. A non-remote executor's
  fallback is an ordinary failure (B-100; `executor-fallback.test.ts`).
  `@vzn/vx-reapi`'s `queueTimeoutMs` is its consumer.

## Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor as tasks
  — a worker cannot hand the submitter a port. A `servers` executor gets
  them as a dependant's `req.servers` instead; a server every dependant
  of which went to one is never spawned here (2026-10-22: nothing
  runs on a DTE run's orchestrator). One with `exec.sandbox` or
  `exec.remote: false`, or one the run holds for itself (requested), is
  not carried.
- A `timeouts` executor enforces `timeoutMs` where it runs the command,
  timed from its start, and reports `timedOut`; core arms no clock for
  it, so the wait for a worker still booting is not the task's run time
  (a 0.5 s task with a 2 s timeout was killed unrun, 2026-10-24). The
  run's stop still aborts its request.
- An `exclusive` executor runs every task of the run (2026-10-24:
  no task ever runs on a DTE run's orchestrator; only hits
  restore there). Nothing is pinned for it: `exec.remote: false`,
  `exec.interactive`, sandboxed and probed tasks and every server a
  dependant needs go to it. A task that would still land on the local
  floor (a platform it does not offer, one it declines, a probe it does
  not check, a server requested on its own) refuses the run, naming it.
- A task is `pinnedLocal` when it is persistent, transitively depends on a
  persistent task its executor does not carry, is
  sandboxed (the sandbox is this machine's machinery), depends on a
  sandboxed task (both unless the executor declares `sandbox`), declares `exec.remote: false`, or folds a runtime
  probe (`inputs.runtime` / `workspaceRuntime`) into its key unless the
  executor declares `runtime`: the probe is this machine's answer, and a
  worker's output under it is a stale hit (C-2). `placement.ts`
  computes the set once per run (`tests/placement.test.ts`).
- A task naming `exec.platforms` goes to an executor whose `platforms`
  share one, on the host's platform if both list it, else the first of the
  task's the executor runs (`node.platform`, folded into its key). Placed
  anywhere else it runs here when this machine is one of its platforms;
  if not, it is `otherPlatform`: a local run skips it and its dependants,
  green, while CI, or a routing executor that runs none of its platforms
  (`unroutable`), refuses the run before any task starts
  (`platformVerdict`, `tests/task-platforms.test.ts`).
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
  input. Same-checkout workers get them from the checkout; an input-shipping
  executor needs them declared or provided by the worker image / an install
  action.

## Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

## Replacing this module

Contribute `executor(ctx)` from a plugin. `localExecutor()` is not on
`@vzn/vx`; an executor that declines a task (`accepts` → false) hands it
to the local floor.
