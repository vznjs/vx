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
  cachePolicy?: CachePolicy // 4-axis read/write control; undefined → everything on
  forwardArgs?: readonly string[]
  retries?: number // run-level retry default (--retry); exec.retries wins
  log: Logger
  nestedProjectDirs: string[]
  runStartHrTimeNs: bigint
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  liveChildren?: Set<ReturnType<typeof Bun.spawn>> // run-scoped; the signal handler signals these
}

export function executeTask(args: ExecuteArgs): Promise<TaskOutcome>
```

Cache-key derivation (`ComputeHashArgs`, `computeTaskHash`,
`computeGroupHash`) moved to `src/orchestrator/task-hash.ts` —
[`task-hash.md`](./task-hash.md).

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
   - A restore that throws `ArtifactVanishedError` (the artifact was
     removed after the probe: a `vx cache prune` in another shell,
     another workspace's retention on a shared cache directory) is a
     miss: one status line naming the task and the artifact, ending
     `— running it`, then step 4. A hit the
     up-front probe found (`preProbed`) may be restoring ahead of its
     deps, so it throws `RestoreDemoted` instead and the scheduler
     runs it once they are done (scheduler.md; admission drops the
     probe, so that dispatch probes afresh and misses).
4. Miss-or-no-cache:
   - If caching enabled, `cleanOutputs(cleanArgs)` first so a stale
     `dist/` doesn't survive into a fresh exec.
   - Build isolated env (`<projectDir>/node_modules/.bin` PATH
     prepend).
   - `wallclockStartNs = process.hrtime.bigint() - runStartHrTimeNs`.
   - The attempt builds an `ExecuteRequest` (command, env, capture,
     declared outputs, timeout, sandbox grants) and hands it to
     `args.executor` — the executor this task was PLACED on by `run.ts`
     before scheduling, so every attempt of a task runs in the same
     place. With no executor plugin declared that is the local floor —
     `runCommand` / `runSandboxed` exactly as before.
   - Up to `1 + (exec.retries ?? args.retries ?? 0)` attempts: a failed
     attempt (timeouts included, `aborted` NOT — a teardown breaks out
     immediately) re-cleans declared outputs and re-executes, with one
     `vx: retrying <id> (attempt <k>/<total>) after exit <code>` stderr
     line between attempts, which ends `after a timeout` instead when
     the attempt was killed by `timeout`. The final outcome (and the
     cached stdout) is the last attempt's; `TaskOutcome.attempts` is
     set when > 1.
   - `wallclockEndNs = process.hrtime.bigint() - runStartHrTimeNs`.
5. **If exit 0 + caching enabled**: the key is re-checked
   (`keyStillTrue`, item 743): the key the describe re-derived before
   the command must equal it, and no input may have moved since its
   fact (`movedInput`). A move withholds the save, says so on the
   status line, and drops the project's facts as an uncached command
   does (every partition when the task declares workspace outputs,
   whose save would have marked them). A workspace fingerprint a task
   rewrote since the run read it withholds the save too (the run's
   `FingerprintWatch`, [`fingerprint-watch.md`](./fingerprint-watch.md),
   item 750). Otherwise `resolveOutputs(...)` →
   `cache.save({ hash, projectDir, outputFiles, entry })`.
   **If it ran here and saves nothing** — it failed, the policy writes
   nothing (`--cache=local:r,remote:r`), an upstream failed, the key no
   longer held — the same re-check runs (`movedInput`), and a move drops
   the project's facts; otherwise its declared outputs are resolved and
   marked in the git snapshot as a save marks them (`markUnsaved`). A
   same-run reader keyed from the snapshot's OIDs for either replayed
   the bytes from before the command (item 750). A deferred or
   remote-only task wrote nothing here and marks nothing, and nor does
   one nothing in the run depends on (`noDependants`, set by `run.ts`):
   no task is ordered after it to read what it wrote, and the output
   walk cost 1,000 read-only misses 1.62 → 1.78 s (min of 9).
6. Return outcome with hash, status (`success` / `failed`),
   exitCode, durationMs, captured stdout/stderr, hrtime spans, and
   (when Bun's resourceUsage returned them) `cpuMs` / `peakRssBytes` —
   the peak only when it rose above vx's own footprint (runner.md).

## The hit

A confirmed hit is materialised by `hit-restore.ts` (`restoreHit`):
the two proofs that let a current tree skip the restore, clean +
restore otherwise, the git marking, the stdout replay, the outcome.
Moved out on 2026-09-10 as pure code motion; re-exported from here.

## The save

An ADDITIVE task (`node.addsToOutputsOf`, item 588) is not cleaned by
glob before an attempt: its outputs are stamped once before the first
attempt (`stampOutputs`) and, after a 0 exit, its own set is what the
run added or changed against that stamp (`ownOutputsSince`), handed to
`saveMiss` as `ownOutputFiles` in place of the glob walk.

What a miss leaves behind — outputs resolved, artifact and rows saved,
output prefixes recorded, git snapshot marked — is
[`miss-save.md`](./miss-save.md); `execute-task.ts` calls it under the
`exitCode === 0 && willSave` gate and keeps the deferred-download
branch beside it.

## The lazy probe

A task not probed up front asks the run's `FingerprintWatch` before its
`cache.get`: once a task rewrote a fingerprinted file, the key (which
folded the old digest) is not probed, and the task runs.

## What a command may have written

A task with no `cache` block declares no outputs, so after its command
exits — pass or fail — and after a persistent task becomes ready, the
run drops the facts it holds about where `undeclaredWriteReach`
(`sandbox-request.md`) says the task may have written: `'project'`
deletes the project's git snapshot and its index OIDs, the
workspace-wide partition and the project's `package.json` digest memo;
`'workspace'` clears every partition and every digest. The next reader
re-enumerates (one `git ls-files`) and hashes by content. A task on a
remote executor wrote on its own disk and drops nothing (item 743:
turborepo#13788, `tests/undeclared-writes.test.ts`). Any task that
`mayWriteFingerprint` (`sandbox-request.md`) tells the run's
`FingerprintWatch` it ran, cached or not.

## Sandbox request

The `sandbox` half of the `ExecuteRequest` (grants, denials, the paths a
bind needs pre-created) is built by
[`sandbox-request.md`](./sandbox-request.md); `execute-task.ts` only
asks for it when the task declares `exec.sandbox`, passing the run's
keyed set for the task when it declares `cache`
([`keyed-projects.md`](./keyed-projects.md)) and nothing otherwise (the
persistent path never does). A reported denial under a linked package
the request withheld gets one more line beside it
(`withheldLinkLine`): the package, the link, and the two ways to key it.

## Verdict

A step that exits 127 or 126 gets one frame line from
`shell-verdict.ts` (`shellVerdict`), because the shell's own line names
the word and nothing about why. A bare word is a PATH lookup and the
PATH is vx's: the line names the word (`execWord`, the predicate
`execWrap` uses, so a pipeline says "a command in this task"), the two
bin directories `taskBinDirs` prepends, and that a sibling project's bin
is never on it; a bare word on 126 gets `chmod +x`. A word with a slash
is a file, and the file says why, under either code: missing (the
resolved path), a directory, no execute bit, a `#!` line ending in CRLF
(the interpreter's name ends in `\r`), a `#!` interpreter that does not
exist, or no `#!` line at all (the loader refused a binary). Probed
2026-09-16: dash and bash 5 exit 127 for a missing interpreter and
blame the file; macOS's bash 3.2 names the interpreter itself ("bad
interpreter") and exits 1, so vx adds nothing there. An exit above 128
is a signal's number: a signal the runner saw (`RunResult.signal`) is
named as definite, a bare code (a pipeline's last command) as "a death
by SIGSEGV in the last command, or that command exited 139 itself", and
each signal carries what sends it — SIGKILL the OOM killer or a kill,
SIGSEGV/SIGBUS/SIGILL/SIGFPE a crash in native code, SIGABRT an
assertion or a JS runtime's heap limit, SIGPIPE a reader that left,
SIGXCPU/SIGXFSZ a ulimit, SIGSYS a seccomp filter or the sandbox. A
SIGINT/SIGTERM the runner saw is the abort path's (the task reverts to
aborted) and gets no line. A timed-out step gets no line either: its
own line names the timeout. Pinned in `tests/shell-verdict.test.ts` on real files and
end to end in `tests/tool-not-on-path.test.ts` and
`tests/signal-death.test.ts`.

## Hash derivation (`computeTaskHash`)

The pieces folded into `cache.key(...)`:

| Field                    | Source                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`                 | `node.id`                                                                                                                                                   |
| `taskConfigHash`         | `xxh3(JSON.stringify(hashableConfig(node.config)))` (internal `hashTaskConfig`; the projection drops `exec.remote`, which is placement, not key material)   |
| `projectPackageJsonHash` | the git blob OID of `<projectDir>/package.json` — its index OID when the file is clean, else computed (internal `hashProjectPackageJson`); `''` when absent |
| `envValues`              | `resolveInputs` reads host env for declared `inputs.env` names                                                                                              |
| `inputFiles`             | `resolveInputs` glob result (gitignore + boundary-filtered, sorted)                                                                                         |
| `upstreamHashes`         | `filterUpstreamHashes(upstream, cacheCfg?.inputs?.tasks, ...)`                                                                                              |
| `workspaceFingerprint`   | passed in                                                                                                                                                   |
| `forwardArgs`            | `node.requested ? (args.forwardArgs ?? []) : []`                                                                                                            |

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

- **Input tracing is NOT one of them.** Recording reads during exec and
  using the observed set as the next run's inputs is a rejected
  approach (CLAUDE.md § Rejected): inputs stay declared and explicit.
  A task that wants its reads confined to the paths it declared asks
  for that with `exec.sandbox`, which enforces rather than infers.
  The user's grants derive NOTHING from `cache`: `cache.inputs` says
  what invalidates a task, `exec.sandbox.allow` says what it may touch.
  Declaring `cache` only narrows core's own `node_modules` link grant to
  the packages the key answers for (`keyed-projects.md`).
- **Conditional output capture.** Compress / dedupe before save.
  Hook between `resolveOutputs` and `cache.save`.
- **Pre-spawn hooks.** Run a setup script (e.g. cgroup/limits
  application) before each spawn: contribute an `executor` that wraps
  `localExecutor()` from `@vzn/vx` — no change to this module.
- **Different cache layer.** Already abstracted via `CacheLayer` —
  the caller decides which.
